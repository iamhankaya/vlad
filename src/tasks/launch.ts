import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  addWorktree, attachWorktree, branchExists, isWorktree, removeWorktree, runGit, worktreePath,
} from "../git/git.js";
import { readDoc, kbPaths } from "../kb/index.js";
import type { ProjectCard, TaskState, VladConfig } from "../kb/index.js";
import { countInbox } from "../inbox/inbox.js";
import { closeWorkerWindow } from "../launcher/index.js";
import type { Launcher } from "../launcher/index.js";
import type { Role } from "../roles/store.js";
import { getTask, listTasks, markStale, roleFor, saveTask, setState } from "./store.js";
import type { Task } from "./store.js";

const ALL_STATES: TaskState[] = [
  "queued", "running", "blocked", "stalled", "awaiting_approval", "done", "failed", "cancelled",
];
const ACTIVE: TaskState[] = ["running", "blocked", "stalled", "awaiting_approval"];

function projectPath(slug: string): string {
  const file = join(kbPaths().projects, `${slug}.md`);
  if (!existsSync(file)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  return readDoc<ProjectCard>(file).data.path;
}

/** Persists the last error on a task without touching its state. */
function recordError(id: string, msg: string): void {
  const t = getTask(id);
  t.data.error = msg;
  saveTask(t);
}

export function buildPrompt(taskFile: string, autonomy: string, role?: { title: string; file: string }): string {
  const base =
    `Sen bir VLAD çalışanısın. Görevin: \`${taskFile}\`. ` +
    `Önce \`vlad-worker\` skill'ini yükle ve protokolünü uygula. Yetki seviyen: \`${autonomy}\`.`;
  if (!role) return base;
  return (
    `${base} Rolün: ${role.title}. Göreve başlamadan önce \`${role.file}\` dosyasını oku ` +
    `ve oradaki sorumluluk, yetki ve çıktı kurallarına uy.`
  );
}

/**
 * Pipeline spec §6: makes sure the integration branch `vlad/<parent>` (from the repo's HEAD) and
 * its worktree exist, records them on the pipeline task and moves a queued pipeline to `running`.
 */
export function ensureIntegration(parentId: string, cfg: VladConfig): { repo: string; branch: string; worktree: string } {
  const p = getTask(parentId);
  const repo = projectPath(p.data.project);
  const branch = `vlad/${parentId}`;
  const worktree = worktreePath(cfg, repo, parentId);
  if (!branchExists(repo, branch)) addWorktree(repo, worktree, branch);
  else if (!existsSync(worktree)) attachWorktree(repo, worktree, branch);
  const patch = { branch, worktree };
  if (p.data.state === "queued") setState(parentId, "running", patch);
  else if (p.data.branch !== branch || p.data.worktree !== worktree) {
    Object.assign(p.data, patch);
    saveTask(p);
  }
  return { repo, branch, worktree };
}

/** Opens worktree + branch, starts the launcher and moves the task to `running`. */
export async function launchTask(
  id: string,
  o: { launcher: Launcher; cfg: VladConfig; now?: Date },
): Promise<Task> {
  const task = getTask(id);
  if (task.data.state !== "queued") throw new Error(`görev queued değil (${task.data.state}): ${id}`);
  if (task.data.kind !== "dev") throw new Error(`yalnızca dev görevleri başlatılır (kind=${task.data.kind}): ${id}`);

  const branch = `vlad/${id}`;
  let repo: string;
  let wt: string;
  let role: Role | undefined;
  try {
    if (task.data.role) role = roleFor(task.data.role, task.data.kind);
    repo = projectPath(task.data.project);
    wt = worktreePath(o.cfg, repo, id);
    // a pipeline phase branches from the pipeline's integration branch; the rollback below leaves it alone
    const base = task.data.parent ? ensureIntegration(task.data.parent, o.cfg).branch : undefined;
    addWorktree(repo, wt, branch, base);
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
    // the branch was created by addWorktree just now and has no commits; drop it so a retry can reuse the name
    if (runGit(repo, ["branch", "-d", branch]) === null) problems.push(`branch silinemedi: ${branch}`);
    return problems.join("; ");
  };

  let failure: string | null = null;
  try {
    const res = await o.launcher.launch({
      taskId: id,
      cwd: wt,
      prompt: buildPrompt(task.file, task.data.autonomy, role),
      env: { VLAD_TASK_ID: id, VLAD_HOME: kbPaths().home },
      title: `VLAD ${id} — ${task.data.title}`,
    });
    if (!res.ok) failure = `launcher başarısız (${res.method}): ${res.detail ?? "bilinmeyen hata"}`;
  } catch (e) {
    failure = `launcher başarısız: ${(e as Error).message}`;
  }
  if (failure) {
    const cleanup = undo();
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
  o: { closeWorker?: (taskId: string) => void } = {},
): void {
  const t = getTask(id);
  if (t.data.state !== "done" && t.data.state !== "cancelled") {
    throw new Error(`cleanup yalnızca done/cancelled görevde yapılır (${t.data.state}): ${id}`);
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
    else rmSync(wt, { recursive: true, force: true });
  } catch (e) {
    try {
      rmSync(wt, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
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
): {
  counts: Record<TaskState, number>; active: Task[]; failed: Task[]; newlyStalled: string[]; inbox: number;
  undigested: number;
} {
  const newlyStalled = markStale(now, cfg.staleAfterHours).map((t) => t.data.id);
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
  };
}
