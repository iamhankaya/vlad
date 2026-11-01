import { join } from "node:path";
import { existsSync } from "node:fs";
import { AgentClient } from "../agent/client.js";
import { readLocal } from "../agent/state.js";
import { commitKb, git } from "../kb/commit.js";
import { isSeparateKb, kbPaths } from "../kb/home.js";
import { readDoc } from "../kb/index.js";
import type { ProjectCard, VladConfig } from "../kb/index.js";
import { listTasks, effectiveModel, getTask, roleFor, saveTask } from "../tasks/store.js";
import type { Task } from "../tasks/store.js";
import type { ResumePlan } from "../tasks/resume.js";
import { remoteResumeTemplate } from "../tasks/resume.js";
import type { RemoteDeps } from "../tasks/launch.js";
import { repoNameOf } from "./paths.js";
import { RemoteError } from "./types.js";
import type { RemoteTransport } from "./types.js";

/** Beyin kimliğiyle işçi Agent'larına konuşan gerçek taşıma (anahtarlar `vlad.local.json`'dan). */
export const brainTransport = (cfg: VladConfig, self: string): RemoteTransport =>
  new AgentClient({ self, keys: readLocal().keys, config: () => cfg, defaultTimeoutMs: 70_000 });

/** `task launch` için uzak bağımlılıklar: taşıma + launch öncesi kb-sync. */
export const makeRemote = (cfg: VladConfig, self: string): RemoteDeps => {
  const transport = brainTransport(cfg, self);
  return { transport, syncKb: (machine) => syncKb(transport, machine) };
};

/**
 * Beyin kb'sini işçiye eşitler: kb'deki değişiklikleri commit'ler ve push eder, HEAD'in upstream'de olduğunu doğrular,
 * işçiye `kb-sync {expectSha}` der (işçi fetch + ff-only + sha atalık denetimi yapar). Hata → launch reddedilir.
 */
export async function syncKb(transport: RemoteTransport, machine: string): Promise<void> {
  const paths = kbPaths();
  const cwd = isSeparateKb(paths.home) ? paths.kb : paths.home;
  const c = commitKb("uzak çalışan için kb eşitleme", { push: true });
  if (c.warning) console.error(`uyarı: ${c.warning}`);
  let ahead: string;
  try { ahead = git(cwd, ["rev-list", "--count", "@{u}..HEAD"]).trim(); } catch (e) { throw new Error(`kb upstream bulunamadı, işçiye eşitlenemez: ${(e as Error).message}`); }
  if (ahead !== "0") throw new Error(`kb push edilmemiş ${ahead} commit içeriyor; işçiye eşitlenemez (kb push'u düzelt)`);
  const sha = git(cwd, ["rev-parse", "HEAD"]).trim();
  await transport.call(machine, "kb-sync", { expectSha: sha });
}

const cardOf = (slug: string): ProjectCard => {
  const f = join(kbPaths().projects, `${slug}.md`);
  if (!existsSync(f)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  return readDoc<ProjectCard>(f).data;
};

export async function remoteClose(transport: RemoteTransport, machine: string, id: string): Promise<number[]> {
  return (await transport.call<{ killed: number[] }>(machine, "close", { taskId: id })).result.killed;
}

/** Uzak resume: istem şablonu beyinde kurulur, worktree/kirli yol işçide doldurulur; kb durumu değişmez. */
export async function remoteResume(
  transport: RemoteTransport, machine: string, task: Task, plan: ResumePlan, cfg: VladConfig,
): Promise<{ worktree: string; method: string; dirty: string[] }> {
  const card = cardOf(task.data.project);
  const role = task.data.role ? roleFor(task.data.role, task.data.kind) : undefined;
  const model = effectiveModel(task.data, role);
  const args = {
    taskId: task.data.id, project: task.data.project, repoName: repoNameOf(card.path),
    promptTemplate: remoteResumeTemplate(plan),
    title: `VLAD ${task.data.id} — ${task.data.title}`,
    ...(model ? { model } : {}),
    ...(cfg.workerAutoCompact ? { autoCompact: cfg.workerAutoCompact } : {}),
    ...(plan.sessionId ? { sessionId: plan.sessionId } : {}),
  };
  return (await transport.call<{ worktree: string; method: string; dirty: string[] }>(machine, "resume", args)).result;
}

/**
 * Uzak cleanup (kb kilidi DIŞINDA çağrılır): işçide worktree'yi sildirir; pipeline çatısında fazların projelerindeki
 * entegrasyon worktree'leri de. Fazların başka projeleri için kayıt yoksa (forbidden/not_found) atlanır; görevin kendisi hata verirse yükselir.
 * Başarıdan sonra çağıran, kilit altında `worktree: null` yazar (`markCleaned`).
 */
export async function remoteCleanup(transport: RemoteTransport, machine: string, task: Task): Promise<void> {
  const own = task.data.project;
  const projects = new Set<string>();
  if (task.data.kind === "pipeline") for (const c of listTasks({ parent: task.data.id })) projects.add(c.data.project);
  projects.delete(own);
  const call = (project: string) => transport.call(machine, "cleanup", {
    taskId: task.data.id, project, repoName: repoNameOf(cardOf(project).path), terminal: true,
  });
  for (const p of projects) {
    try { await call(p); } catch (e) {
      if (e instanceof RemoteError && (e.code === "forbidden" || e.code === "not_found")) continue;
      throw e;
    }
  }
  try { await call(own); } catch (e) {
    // retry after a lost `markCleaned`: the worker already removed its record and worktree
    if (e instanceof RemoteError && e.code === "forbidden" && e.message.includes("başlatma kaydı yok")) return;
    throw e;
  }
}

/** Kilit altında: görevin worktree alanını temizler (uzak cleanup başarılıysa). */
export function markCleaned(id: string): void {
  const t = getTask(id);
  t.data.worktree = null;
  saveTask(t);
}
