import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { AgentClient } from "../agent/client.js";
import { readLocal } from "../fleet/state.js";
import { commitKb, git } from "../kb/commit.js";
import { isSeparateKb, kbPaths } from "../kb/home.js";
import { readDoc } from "../kb/index.js";
import type { ProjectCard, VladConfig } from "../kb/index.js";
import { listTasks, effectiveModel, getTask, roleFor, saveTask, saveTaskQuiet } from "../tasks/store.js";
import type { Task } from "../tasks/store.js";
import type { ResumePlan } from "../tasks/resume.js";
import { remoteResumeTemplate } from "../tasks/resume.js";
import { projectPath, remoteMachineOf, sessionArg } from "../tasks/launch.js";
import type { RemoteDeps } from "../tasks/launch.js";
import { repoNameOf } from "../fleet/paths.js";
import { RemoteError } from "../fleet/types.js";
import type { BranchPushResult, GateRunResult, MergePreviewResult, MergeResult, RemoteTransport } from "../fleet/types.js";

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
  let c: ReturnType<typeof commitKb>;
  try { c = commitKb("uzak çalışan için kb eşitleme", { push: true }); } catch (e) { throw new Error(`kb push edilmedi: uzak çalışan görev dosyasını göremez (${(e as Error).message})`); }
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
    ...(await sessionArg(transport, machine)),
  };
  return (await transport.call<{ worktree: string; method: string; dirty: string[] }>(machine, "resume", args)).result;
}

/**
 * Uzak cleanup (kb kilidi DIŞINDA çağrılır): işçide worktree'yi sildirir; pipeline çatısında fazların projelerindeki
 * entegrasyon worktree'leri de. Fazların başka projeleri için kayıt yoksa (forbidden/not_found) atlanır; görevin kendisi hata verirse yükselir.
 * Başarıdan sonra çağıran, kilit altında `worktree: null` yazar (`markCleaned`).
 */
export async function remoteCleanup(transport: RemoteTransport, machine: string, task: Task, expectHead?: string): Promise<void> {
  const own = task.data.project;
  const projects = new Set<string>();
  if (task.data.kind === "pipeline") for (const c of listTasks({ parent: task.data.id })) projects.add(c.data.project);
  projects.delete(own);
  const call = (project: string) => transport.call(machine, "cleanup", {
    taskId: task.data.id, project, repoName: repoNameOf(cardOf(project).path), terminal: true,
    ...(expectHead && project === own ? { expectHead } : {}),
    ...(task.data.state === "cancelled" ? { dropBranch: true } : {}),
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
  saveTaskQuiet(t);
}

// --- machines:C4 --- kapı işlemleri: uzak makinedeki görev/çatı için gate, merge önizleme ve merge (push YOK)
const GATE_CALL_TIMEOUT_MS = 30 * 60_000; // işçinin gate zaman aşımından (25 dk) uzun

/** Kapı işlemlerinin gideceği işçi: görevin kendi uzak makinesi; çatıda uzak makinede koşan ilk faz. Yerelse null. */
export function gateMachineOf(task: Task, cfg: VladConfig): string | null {
  const own = remoteMachineOf(task, cfg);
  if (own || task.data.kind !== "pipeline") return own;
  for (const c of listTasks({ parent: task.data.id })) { const m = remoteMachineOf(c, cfg); if (m) return m; }
  return null;
}

const gateIds = (task: Task) => ({ taskId: task.data.id, project: task.data.project, repoName: repoNameOf(cardOf(task.data.project).path) });
/** Faz → çatı entegrasyon dalı; çatısız (çatı/tek) görev → kartın ana dalı. */
function mergeRefs(task: Task, into?: string): { from: string; into: string } {
  const to = into ?? (task.data.parent ? `vlad/${task.data.parent}` : cardOf(task.data.project).default_branch);
  if (!to) throw new Error(`${task.data.project} kartında default_branch yok; --into ver ya da project set default_branch`);
  return { from: `vlad/${task.data.id}`, into: to };
}

export async function remoteGateRun(transport: RemoteTransport, machine: string, task: Task, target: "integration" | "task" | "base", cachedHead?: string): Promise<GateRunResult> {
  return (await transport.call<GateRunResult>(machine, "gate-run", { ...gateIds(task), target, ...(cachedHead ? { cachedHead } : {}) }, { timeoutMs: GATE_CALL_TIMEOUT_MS })).result;
}
/** Taban dalı (gate --compare-base): faz → vlad/<çatı>, diğerleri → kartın ana dalı; mergeRefs ile aynı eşleme. */
export const baseBranchOf = (task: Task): string => mergeRefs(task).into;
export async function remoteMergePreview(transport: RemoteTransport, machine: string, task: Task, o: { into?: string } = {}): Promise<MergePreviewResult> {
  return (await transport.call<MergePreviewResult>(machine, "merge-preview", { ...gateIds(task), ...mergeRefs(task, o.into) })).result;
}
/** Yeşil gate'i görevin frontmatter'ına yazar (kilit çağıranda). Çalışan bu alanı yazamaz; merge öncesi karşılaştırma buradan okur (F-vlad-139). */
export function recordGreenGate(id: string, r: GateRunResult, target: "integration" | "task"): void {
  if (r.exit !== 0 || !r.head) return;
  const t = getTask(id);
  t.data.last_green_gate = { head: r.head, target, at: new Date().toISOString() };
  saveTask(t);
}
/** Merge edilen dal (vlad/<id>) için geçerli gate hedefi: çatıda entegrasyon worktree'si, diğerinde görevin kendisi. */
export const defaultGateTarget = (task: Task): "integration" | "task" => (task.data.kind === "pipeline" ? "integration" : "task");
/** Görevin son yeşil gate head'i (merge edilecek dalın hedefiyle eşleşen); yoksa null. */
export function lastGreenGateHead(task: Task): string | null {
  const g = task.data.last_green_gate;
  return g && g.target === defaultGateTarget(task) ? g.head : null;
}
export async function remoteMerge(transport: RemoteTransport, machine: string, task: Task, o: { into?: string; message?: string } = {}): Promise<MergeResult> {
  const refs = mergeRefs(task, o.into);
  const expectHead = lastGreenGateHead(task);
  if (!expectHead) throw new Error(`${task.data.id} için yeşil gate kaydı yok; önce vlad task gate ${task.data.id} --target ${defaultGateTarget(task)} koş, sonra merge et`);
  return (await transport.call<MergeResult>(machine, "merge", { ...gateIds(task), ...refs, expectHead, ...(o.message ? { message: o.message } : {}) }, { timeoutMs: 330_000 })).result;
}
// --- /machines:C4 ---
// --- machines:branch-push (F-vlad-314, sözleşme T20261111-50) --- uzak görev dalını origin'e itme + beyinde alma
/** Gate'lenen sha'yı (`expectHead`) görevin `vlad/<id>` dalı olarak origin'e iter; yalnız beyinden, force yok. Hata RemoteError (`conflict [diverged]`, `failed [stale_tip|push_rejected|no_origin|auth]`). */
export async function remoteBranchPush(transport: RemoteTransport, machine: string, task: Task, expectHead: string): Promise<BranchPushResult> {
  const { taskId, project, repoName } = gateIds(task);
  return (await transport.call<BranchPushResult>(machine, "branch-push", { taskId, project, repoName, branch: `vlad/${taskId}`, expectHead }, { timeoutMs: 150_000 })).result;
}
/** Beyinde `git fetch origin vlad/<id>`; FETCH_HEAD gate'lenen sha olmalı. Yerel `refs/heads/vlad/<id>` yaratılmaz, merge sha ile yapılır. */
export function fetchBranchHead(repo: string, id: string, expectHead: string): void {
  const run = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  // tam ref + geçici ref: FETCH_HEAD yarışı yok; hata iletisine git stderr/URL girmez (F-vlad-321/322)
  const tmp = `refs/vladfetch/${id}`;
  const f = run(["fetch", "--no-tags", "origin", `+refs/heads/vlad/${id}:${tmp}`]);
  if (f.status !== 0) throw new Error(`git fetch başarısız (kod ${f.status ?? "?"})`);
  const head = run(["rev-parse", "--verify", "--quiet", `${tmp}^{commit}`]).stdout?.trim();
  run(["update-ref", "-d", tmp]);
  if (head !== expectHead) throw new Error(`FETCH_HEAD (fetch edilen uç, ${(head ?? "").slice(0, 12) || "yok"}) gate'lenen sha'dan (${expectHead.slice(0, 12)}) farklı`);
}
/**
 * F-vlad-328: Agent yanıtı tek başına kanıt değildir (işçi `done()` her zaman `head: expectHead` döndürür).
 * Yanıtın alanları tutarlı olmalı: head = gate'lenen sha, branch = vlad/<id>, remote = origin, pushed boolean.
 */
export function checkBranchPushReply(r: BranchPushResult, id: string, expectHead: string): void {
  if (!r || typeof r !== "object") throw new Error("işçi dal ucu doğrulanamadı: branch-push yanıtı geçersiz");
  if (r.head !== expectHead) throw new Error("işçi dal ucu doğrulanamadı: yanıt head'i gate'lenen sha değil");
  if (r.branch !== `vlad/${id}`) throw new Error(`işçi dal ucu doğrulanamadı: yanıt branch'i vlad/${id} değil`);
  if (r.remote !== "origin") throw new Error("işçi dal ucu doğrulanamadı: yanıt remote'u origin değil");
  if (typeof r.pushed !== "boolean") throw new Error("işçi dal ucu doğrulanamadı: yanıt pushed alanı boolean değil");
}
/** Beyinden bağımsız kanıt: `ls-remote origin refs/heads/vlad/<id>` tam eşleşen satırın sha'sı gate'lenen sha olmalı. */
export function checkOriginTip(repo: string, id: string, expectHead: string): void {
  const ref = `refs/heads/vlad/${id}`;
  const r = spawnSync("git", ["ls-remote", "origin", ref], { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error("işçi dal ucu doğrulanamadı: beyinde origin'e ulaşılamadı (ls-remote)");
  const sha = (r.stdout ?? "").split("\n").map((l) => l.trim().split(/\s+/)).find(([, name]) => name === ref)?.[0] ?? "";
  if (!sha) throw new Error(`işçi dal ucu doğrulanamadı: origin'de ${ref} yok`);
  if (sha !== expectHead) throw new Error(`işçi dal ucu doğrulanamadı: origin ucu (${sha.slice(0, 12)}) gate'lenen sha'dan (${expectHead.slice(0, 12)}) farklı`);
}
/** close verifyTip: Agent çağrısı (işçide kuyruk içi stale_tip) + yanıt tutarlılığı + beyinde bağımsız origin kanıtı. */
export async function verifyRemoteTip(call: () => Promise<BranchPushResult>, repo: string, id: string, expectHead: string): Promise<void> {
  checkBranchPushReply(await call(), id, expectHead);
  checkOriginTip(repo, id, expectHead);
}
/** Beyin-yerel repo yolu: close'un fetch/önizleme/merge/ancestry adımlarının tek çözümü (kart yolu başka OS'tansa brain roots, F-vlad-200). */
export const brainRepoPath = (project: string, cfg?: VladConfig): string => projectPath(project, cfg);
export async function fetchTaskBranch(task: Task, expectHead: string, cfg?: VladConfig): Promise<void> {
  fetchBranchHead(brainRepoPath(task.data.project, cfg), task.data.id, expectHead);
}
// --- /machines:branch-push ---
