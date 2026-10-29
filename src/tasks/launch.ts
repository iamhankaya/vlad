import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  addWorktree, attachWorktree, branchExists, isWorktree, ReparseCleanupError, remoteBranchExists, removeWorktree, runGit,
  unlinkReparsePoints, worktreeBranch, worktreePath,
} from "../git/git.js";
import { readDoc, kbPaths } from "../kb/index.js";
import type { ProjectCard, TaskState, VladConfig } from "../kb/index.js";
import { countOpenSevere } from "../findings/store.js";
import { countInbox } from "../inbox/inbox.js";
import { closeWorkerWindow } from "../launcher/index.js";
import type { Launcher } from "../launcher/index.js";
import { splitSkills } from "../roles/store.js";
import type { Role } from "../roles/store.js";
import { markSilentWorkers } from "./liveness.js";
import type { LivenessProbe } from "./liveness.js";
import {
  effectiveModel, getTask, listTasks, markStale, roleFor, saveTask, setState, syncAutonomy, unmetDependencies,
} from "./store.js";
import type { Task } from "./store.js";
import { BLOCKS_HEADING, standardBlocks } from "./blocks.js";
import type { BlockCtx } from "./blocks.js";
import { expireMode, modeLine } from "../mode/store.js";
import { trustWorktree, untrustWorktree } from "./trust.js";

const ALL_STATES: TaskState[] = [
  "queued", "running", "blocked", "stalled", "awaiting_approval", "done", "failed", "cancelled",
];
const ACTIVE: TaskState[] = ["running", "blocked", "stalled", "awaiting_approval"];

function projectCard(slug: string): ProjectCard {
  const file = join(kbPaths().projects, `${slug}.md`);
  if (!existsSync(file)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  return readDoc<ProjectCard>(file).data;
}

const projectPath = (slug: string): string => projectCard(slug).path;
const projectDefaultBranch = (slug: string): string | undefined => projectCard(slug).default_branch ?? undefined;

/** Persists the last error on a task without touching its state. */
function recordError(id: string, msg: string): void {
  const t = getTask(id);
  t.data.error = msg;
  saveTask(t);
}

export function buildPrompt(
  taskFile: string, autonomy: string, role?: { title: string; file: string; skills?: string[] },
  ctx?: { taskId: string; parent: string | null; projectSkills?: string[] },
): string {
  const core = promptCore(taskFile, autonomy, role);
  if (!ctx) return core;
  const blocks = standardBlocks({ taskId: ctx.taskId, autonomy: autonomy as BlockCtx["autonomy"], parent: ctx.parent, mode: "local", projectSkills: ctx.projectSkills });
  return [core, BLOCKS_HEADING, ...blocks].join("\n\n");
}

function promptCore(taskFile: string, autonomy: string, role?: { title: string; file: string; skills?: string[] }): string {
  const base =
    `Sen bir VLAD çalışanısın. Görevin: \`${taskFile}\`. ` +
    `Önce \`vlad-worker\` skill'ini yükle ve protokolünü uygula. Yetki seviyen: \`${autonomy}\`.`;
  if (!role) return base;
  const withRole =
    `${base} Rolün: ${role.title}. Göreve başlamadan önce \`${role.file}\` dosyasını oku ` +
    `ve oradaki sorumluluk, yetki ve çıktı kurallarına uy.`;
  const { load, vendored } = splitSkills(role.skills ?? [], role.file);
  const parts = [withRole];
  if (load.length) {
    parts.push(`İşe başlamadan şu skill'leri yükle: ${load.map((s) => `\`${s}\``).join(", ")}. Yüklenemeyen olursa kapanış raporunda belirt.`);
  }
  for (const v of vendored) parts.push(`\`${v.name}\` skill'i yüklü değildir; \`${v.file}\` dosyasını oku ve uygula.`);
  return parts.join(" ");
}

const CLOSED: TaskState[] = ["done", "cancelled", "failed"];

/**
 * Pipeline spec §6: makes sure the integration branch `vlad/<parent>` and its worktree exist in the
 * repo of `project` (the phase's project; default: the pipeline's own). A missing local branch is
 * tracked from `origin/vlad/<parent>` if that exists, else cut from the card's default branch (HEAD
 * when unset). Only a phase of the pipeline's own project records branch/worktree on the pipeline
 * task: in another project's repo the worktree path is derived (`worktreePath(cfg, repo, parent)`).
 * The pipeline itself moves to `running` only when its phase does (setState), so a failed launch
 * leaves it queued.
 */
export function ensureIntegration(
  parentId: string, cfg: VladConfig, project?: string,
): { repo: string; branch: string; worktree: string } {
  const p = getTask(parentId);
  if (CLOSED.includes(p.data.state)) throw new Error(`çatı görev ${parentId} ${p.data.state}; fazı başlatılamaz`);
  const slug = project ?? p.data.project;
  const repo = projectPath(slug);
  const branch = `vlad/${parentId}`;
  const worktree = worktreePath(cfg, repo, parentId);
  if (!branchExists(repo, branch)) {
    if (remoteBranchExists(repo, branch)) addWorktree(repo, worktree, branch, `origin/${branch}`);
    else {
      const def = projectDefaultBranch(slug);
      addWorktree(repo, worktree, branch, def && branchExists(repo, def) ? def : undefined);
    }
  } else if (!existsSync(worktree)) attachWorktree(repo, worktree, branch);
  else if (!isWorktree(repo, worktree)) {
    // a merge into it at the gate would fail or, inside the repo, hit the wrong branch
    throw new Error(`entegrasyon klasörü bir git worktree'si değil: ${worktree}; klasörü kaldırıp tekrar dene`);
  }
  if (slug === p.data.project && (p.data.branch !== branch || p.data.worktree !== worktree)) {
    Object.assign(p.data, { branch, worktree });
    saveTask(p);
  }
  return { repo, branch, worktree };
}

/**
 * F-vlad-063: the integration worktrees of a pipeline, one per project its phases run in (plus the
 * pipeline's own). Derived, not recorded: the pipeline task's `worktree` only covers its own project.
 */
export function integrationWorktrees(
  parentId: string, cfg: VladConfig, all?: Task[],
): { project: string; repo: string; branch: string; worktree: string }[] {
  // `all`: tasks the caller already loaded (task list), so N pipelines do not re-read the whole kb N times (F-vlad-094)
  const parent = all?.find((t) => t.data.id === parentId) ?? getTask(parentId);
  const projects = new Set([parent.data.project]);
  for (const c of all ? all.filter((t) => t.data.parent === parentId) : listTasks({ parent: parentId })) projects.add(c.data.project);
  const branch = `vlad/${parentId}`;
  const out: { project: string; repo: string; branch: string; worktree: string }[] = [];
  for (const project of projects) {
    // a phase project whose card is gone must not block listing or cleanup of the rest
    if (!existsSync(join(kbPaths().projects, `${project}.md`))) continue;
    const repo = projectPath(project);
    const worktree = worktreePath(cfg, repo, parentId);
    if (!out.some((w) => w.worktree === worktree)) out.push({ project, repo, branch, worktree });
  }
  return out;
}

/** Opens worktree + branch, starts the launcher and moves the task to `running`. */
export async function launchTask(
  id: string,
  o: { launcher: Launcher; cfg: VladConfig; now?: Date; branchOf?: (worktree: string) => string | null },
): Promise<Task> {
  const task = getTask(id);
  if (task.data.state !== "queued") throw new Error(`görev queued değil (${task.data.state}): ${id}`);
  if (task.data.kind !== "dev") throw new Error(`yalnızca dev görevleri başlatılır (kind=${task.data.kind}): ${id}`);
  const unmet = unmetDependencies(task);
  if (unmet.length) throw new Error(`bağımlılıklar tamamlanmadı: ${unmet.join(",")}`);

  const stale = syncAutonomy(task, o.cfg);
  if (stale) console.error(`uyarı: ${id} yetkisi config'ten güncellendi (${stale} → ${task.data.autonomy})`);

  const branch = `vlad/${id}`;
  let repo: string;
  let wt: string;
  let role: Role | undefined;
  let created: string | null = null;
  try {
    if (task.data.role) role = roleFor(task.data.role, task.data.kind);
    repo = projectPath(task.data.project);
    wt = worktreePath(o.cfg, repo, id);
    // a pipeline phase branches from the pipeline's integration branch; the rollback below leaves it alone
    const base = task.data.parent ? ensureIntegration(task.data.parent, o.cfg, task.data.project).branch : undefined;
    addWorktree(repo, wt, branch, base);
    // F-vlad-044: a worktree left on another branch (e.g. the integration branch) would let the worker commit past the gate
    const actual = (o.branchOf ?? worktreeBranch)(wt);
    if (actual !== branch) {
      try { removeWorktree(repo, wt); } catch { /* the branch cleanup and the error below still matter */ }
      // addWorktree refuses an existing branch, so `branch` (if present) was created just now; keep the name free for a retry
      if (branchExists(repo, branch)) runGit(repo, ["branch", "-D", branch]);
      throw new Error(`worktree beklenen faz dalında değil (beklenen ${branch}, bulunan ${actual ?? "yok"}): ${wt}`);
    }
    created = runGit(repo, ["rev-parse", branch]);
  } catch (e) {
    const msg = (e as Error).message;
    recordError(id, msg);
    throw new Error(msg);
  }

  /** Rolls back worktree + branch; returns a description of what failed to clean up, or "". */
  const undo = (): string => {
    const problems: string[] = [];
    try {
      removeWorktree(repo, wt);
    } catch (e) {
      problems.push(`worktree kaldırılamadı (${wt}): ${(e as Error).message}`);
    }
    // the branch was created by addWorktree just now; drop it so a retry can reuse the name. Still at
    // its starting commit → nothing to lose, force it (-d refuses when the base is ahead of HEAD, as an
    // integration branch is); new commits on it → -d, which keeps unmerged work.
    const untouched = created !== null && runGit(repo, ["rev-parse", branch]) === created;
    if (runGit(repo, ["branch", untouched ? "-D" : "-d", branch]) === null) problems.push(`branch silinemedi: ${branch}`);
    return problems.join("; ");
  };

  // a worktree missing from ~/.claude.json parks the worker on the "Quick safety check" screen
  const trustWarning = trustWorktree(wt);
  if (trustWarning) console.error(`uyarı: ${trustWarning}`);

  const model = effectiveModel(task.data, role);
  let failure: string | null = null;
  try {
    const res = await o.launcher.launch({
      taskId: id,
      cwd: wt,
      prompt: buildPrompt(task.file, task.data.autonomy, role, { taskId: id, parent: task.data.parent ?? null, projectSkills: projectCard(task.data.project).skills }),
      env: { VLAD_TASK_ID: id, VLAD_HOME: kbPaths().home },
      title: `VLAD ${id} — ${task.data.title}`,
      ...(model ? { model } : {}),
    });
    if (!res.ok) failure = `launcher başarısız (${res.method}): ${res.detail ?? "bilinmeyen hata"}`;
  } catch (e) {
    failure = `launcher başarısız: ${(e as Error).message}`;
  }
  if (failure) {
    const cleanup = undo();
    untrustWorktree(wt);
    if (cleanup) failure += `; temizlik başarısız: ${cleanup}`;
    recordError(id, failure);
    throw new Error(failure);
  }
  try {
    return setState(id, "running", { branch, worktree: wt, error: null });
  } catch (e) {
    const msg = `terminal açıldı ama durum güncellenemedi: ${(e as Error).message}; worktree: ${wt}`;
    try { recordError(id, msg); } catch { /* best effort */ }
    throw new Error(msg);
  }
}

/**
 * Closes the worker's window, then removes the worktree of a done/cancelled task.
 * The branch is left alone.
 */
export function cleanupTask(
  id: string,
  o: { closeWorker?: (taskId: string) => void; cfg?: VladConfig } = {},
): void {
  const t = getTask(id);
  if (t.data.state !== "done" && t.data.state !== "cancelled") {
    throw new Error(`cleanup yalnızca done/cancelled görevde yapılır (${t.data.state}): ${id}`);
  }
  if (t.data.kind === "pipeline" && o.cfg) {
    // integration worktrees of the other projects the phases ran in (F-vlad-063); the own one is handled below
    for (const w of integrationWorktrees(id, o.cfg)) {
      if (w.worktree === t.data.worktree || !existsSync(w.worktree)) continue;
      removeTaskWorktree(w.repo, w.worktree, id);
    }
  }
  const wt = t.data.worktree;
  if (!wt) return;
  if (existsSync(wt)) {
    try {
      (o.closeWorker ?? closeWorkerWindow)(id);
    } catch {
      /* a window that could not be closed is reported by the removal below */
    }
    removeTaskWorktree(projectPath(t.data.project), wt, id);
  }
  const trustWarning = untrustWorktree(wt);
  if (trustWarning) console.error(`uyarı: ${trustWarning}`);
  t.data.worktree = null;
  saveTask(t);
}

/**
 * On Windows an open terminal whose cwd is the worktree locks the folder: `git worktree remove`
 * then unregisters the worktree but fails to delete it. A leftover, unregistered folder is
 * deleted directly (retrying while a just-killed window releases it) so that a retry succeeds.
 */
function removeTaskWorktree(repo: string, wt: string, id: string): void {
  try {
    if (isWorktree(repo, wt)) removeWorktree(repo, wt);
    else { unlinkReparsePoints(wt); rmSync(wt, { recursive: true, force: true }); }
  } catch (e) {
    // fail-closed: links that could not be detached must never reach the retry/rmSync fallback below
    if (e instanceof ReparseCleanupError) {
      throw new Error(
        `worktree bağlantıları kaldırılamadı, silme yapılmadı: ${wt}. \`vlad task cleanup ${id}\` ile tekrar dene. (${e.message})`,
      );
    }
    try {
      unlinkReparsePoints(wt); // git may have failed before touching links; the fallback must not follow one either
      rmSync(wt, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e2) {
      if (e2 instanceof ReparseCleanupError) throw new Error(`worktree bağlantıları kaldırılamadı, silme yapılmadı: ${wt}. (${e2.message})`);
      /* reported below */
    }
    runGit(repo, ["worktree", "prune"]);
    if (!existsSync(wt)) return;
    throw new Error(
      `worktree klasörü silinemedi, çalışan penceresi hâlâ açık olabilir: ${wt}. ` +
        `Pencereyi kapatıp \`vlad task cleanup ${id}\` komutunu tekrar çalıştır. (${(e as Error).message})`,
    );
  }
}

export function statusSummary(
  cfg: VladConfig,
  now: Date,
  probe?: LivenessProbe,
  platform?: NodeJS.Platform,
): {
  counts: Record<TaskState, number>; active: Task[]; failed: Task[]; newlyStalled: string[]; inbox: number;
  undigested: number; openSevereFindings: number; mode: string | null;
} {
  const newlyStalled = [
    ...markStale(now, cfg.staleAfterHours),
    ...markSilentWorkers(now, cfg, probe, platform),
  ].map((t) => t.data.id);
  const mode = modeLine(now);
  try { expireMode(now); } catch { /* a locked mode.json must not take the startup summary down */ } // an elapsed window is reported once, then cleared
  const tasks = listTasks();
  const counts = Object.fromEntries(ALL_STATES.map((s) => [s, 0])) as Record<TaskState, number>;
  for (const t of tasks) counts[t.data.state]++;
  return {
    counts,
    active: tasks.filter((t) => ACTIVE.includes(t.data.state)),
    failed: tasks.filter((t) => t.data.state === "failed" || (t.data.state === "queued" && !!t.data.error)),
    newlyStalled,
    inbox: countInbox(),
    undigested: tasks.filter((t) => t.data.state === "done" && !t.data.digested).length,
    openSevereFindings: countOpenSevere(),
    mode,
  };
}
