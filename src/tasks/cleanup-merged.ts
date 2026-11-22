import { existsSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { branchExists, runGit, runGitRaw, worktreePath } from "../git/git.js";
import type { VladConfig } from "../kb/index.js";
import { listProjects } from "../projects/store.js";
import { defaultProbe, type LivenessProbe } from "./liveness.js";
import { unmergedCommits } from "./launch-core.js";
import { cleanupTask, integrationWorktrees, projectPath, remoteMachineOf } from "./launch.js";
import { listTasks, type Task } from "./store.js";

/**
 * F-vlad-375: finished tasks left their worktrees behind (APK builds ~6.6 GB each) and the disk filled up.
 * `task cleanup --merged` removes the worktree of every done/cancelled task whose branch has fully reached its target
 * (phase: the pipeline's integration branch or the main branch; single task: the main branch). The branch itself is kept.
 * Anything that could hold unsaved work is skipped with a reason: open worker window, uncommitted changes, unmerged commits,
 * no proof (missing branch, detached HEAD, git error), remote machine.
 */
export type MergedItem = {
  id: string; project: string; worktree: string;
  action: "remove" | "skip";
  /** why it is skipped */
  reason?: string;
  /** approximate size of the worktree folder(s) */
  bytes?: number;
  /** set after a real removal attempt */
  removed?: boolean;
  error?: string;
};
export type MergedResult = { dryRun: boolean; items: MergedItem[]; removed: number; errors: number; candidateBytes: number; freedBytes: number };
export type MergedOpts = {
  dryRun: boolean;
  project?: string;
  /** a process mentioning the task id means its window is open */
  probe?: Pick<LivenessProbe, "alive">;
  closeWorker?: (taskId: string) => void;
  /** test seam: the real removal */
  cleanup?: (id: string) => void;
  /** time budget (ms) for size estimation across the whole run; the numbers are approximate */
  sizeBudgetMs?: number;
};

/** Only VLAD's own `.remember` folder (recreated by the remember plugin) does not count as uncommitted work. */
const dirtyEntries = (wt: string): string[] | null => {
  const out = runGitRaw(wt, ["status", "--porcelain", "--untracked-files=normal"], 60_000);
  if (out === null) return null;
  return out.split("\n").filter((l) => l.trim() && !/^\?\? \.remember(\/|$)/.test(l));
};

const defaultBranchOk = (repo: string): boolean => runGit(repo, ["symbolic-ref", "-q", "HEAD"]) !== null;

/** Approximate bytes under `dir` (lstat sizes, symlinks not followed); stops when the deadline passes. */
function dirBytes(dir: string, deadline: number): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) break;
    const cur = stack.pop()!;
    let names: string[];
    try { names = readdirSync(cur); } catch { continue; }
    for (const n of names) {
      const p = join(cur, n);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) stack.push(p); else total += st.blocks ? st.blocks * 512 : st.size;
      } catch { /* vanished while scanning */ }
    }
  }
  return total;
}

type Target = { repo: string; branch: string; worktree: string };

/** Worktrees to remove for the task and the reason it must stay; `null` reason = eligible. */
function judge(t: Task, cfg: VladConfig, probe: Pick<LivenessProbe, "alive">): { targets: Target[]; reason: string | null } {
  const id = t.data.id;
  if (remoteMachineOf(t, cfg)) return { targets: [], reason: "uzak makinede (bu makinede worktree yok)" };
  let repo: string;
  try { repo = projectPath(t.data.project, cfg); } catch { return { targets: [], reason: "proje yolu çözülemedi" }; }
  if (!existsSync(repo)) return { targets: [], reason: "proje deposu bulunamadı" };
  const branch = `vlad/${id}`;
  const targets: Target[] = [];
  if (t.data.kind === "pipeline") {
    // the pipeline's integration worktrees (one per project its phases ran in); all of them must have reached their main branch
    for (const w of integrationWorktrees(id, cfg)) targets.push({ repo: w.repo, branch: w.branch, worktree: w.worktree });
    const live = targets.filter((w) => existsSync(w.worktree));
    if (!t.data.worktree && !live.length) return { targets: [], reason: "worktree yok" };
    for (const w of live) {
      if (!defaultBranchOk(w.repo)) return { targets: [], reason: "ana dal HEAD'i ayrık (kanıt yok)" };
      const n = unmergedCommits(w.repo, w.branch, "HEAD");
      if (n === null) return { targets: [], reason: `merge kanıtı yok (${w.branch})` };
      if (n > 0) return { targets: [], reason: `çatı ana dala merge edilmemiş (${n} commit: ${w.branch})` };
    }
  } else {
    if (!t.data.worktree) return { targets: [], reason: "worktree yok" };
    targets.push({ repo, branch, worktree: t.data.worktree });
    if (existsSync(t.data.worktree)) {
      if (!branchExists(repo, branch)) return { targets: [], reason: `dal bulunamadı (kanıt yok): ${branch}` };
      let merged = false;
      const inte = t.data.parent ? `vlad/${t.data.parent}` : null;
      if (inte && branchExists(repo, inte) && unmergedCommits(repo, branch, inte) === 0) merged = true;
      if (!merged) {
        if (!defaultBranchOk(repo)) return { targets: [], reason: "ana dal HEAD'i ayrık (kanıt yok)" };
        const n = unmergedCommits(repo, branch, "HEAD");
        if (n === null) return { targets: [], reason: `merge kanıtı yok (${branch})` };
        if (n > 0) return { targets: [], reason: `merge edilmemiş (${n} commit${inte ? `; ne ${inte} ne ana dal` : ""})` };
      }
    }
  }
  const live = targets.filter((w) => existsSync(w.worktree));
  if (live.length) {
    const alive = probe.alive(id);
    if (alive === null) return { targets: [], reason: "süreç listesi okunamadı (pencere durumu bilinmiyor)" };
    if (alive) return { targets: [], reason: "çalışan penceresi açık" };
  }
  for (const w of live) {
    const d = dirtyEntries(w.worktree);
    if (d === null) return { targets: [], reason: `git durumu okunamadı: ${w.worktree}` };
    if (d.length) return { targets: [], reason: `kirli: ${d.length} commit'lenmemiş değişiklik (${w.worktree})` };
  }
  return { targets: live, reason: null };
}

export function cleanupMerged(cfg: VladConfig, o: MergedOpts): MergedResult {
  const probe = o.probe ?? defaultProbe();
  const deadline = Date.now() + (o.sizeBudgetMs ?? 20_000);
  const cleanup = o.cleanup ?? ((id: string) => cleanupTask(id, { cfg, ...(o.closeWorker ? { closeWorker: o.closeWorker } : {}) }));
  const items: MergedItem[] = [];
  const tasks = listTasks({ state: ["done", "cancelled"], ...(o.project ? { project: o.project } : {}) });
  for (const t of tasks.sort((a, b) => a.data.id.localeCompare(b.data.id))) {
    const wt = t.data.worktree;
    // a pipeline can have integration worktrees even when its own `worktree` is empty
    if (!wt && t.data.kind !== "pipeline") continue;
    const base = { id: t.data.id, project: t.data.project, worktree: wt ?? "" };
    const j = judge(t, cfg, probe);
    if (j.reason !== null) {
      if (j.reason === "worktree yok") continue;
      items.push({ ...base, action: "skip", reason: j.reason });
      continue;
    }
    items.push({ ...base, action: "remove", bytes: j.targets.reduce((s, w) => s + dirBytes(w.worktree, deadline), 0) });
  }
  const candidateBytes = items.reduce((s, i) => s + (i.action === "remove" ? i.bytes ?? 0 : 0), 0);
  let removed = 0, errors = 0, freedBytes = 0;
  if (!o.dryRun) {
    for (const it of items.filter((i) => i.action === "remove")) {
      try {
        cleanup(it.id);
        it.removed = true; removed++; freedBytes += it.bytes ?? 0;
      } catch (e) { it.error = (e as Error).message; errors++; }
    }
  }
  return { dryRun: o.dryRun, items, removed, errors, candidateBytes, freedBytes };
}

export const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
export const humanBytes = (b: number): string => (b >= 1024 ** 3 ? gb(b) : `${(b / 1024 ** 2).toFixed(1)} MB`);

export const DEFAULT_MIN_FREE_DISK_GB = 20;

export type DiskWarning = {
  freeGb: number; thresholdGb: number; root: string;
  cleanable: { count: number; bytes: number };
  text: string;
};

/** Free bytes of the volume holding `dir` (nearest existing ancestor); null when unreadable. */
export function volumeFreeBytes(dir: string): number | null {
  let cur = dir;
  for (;;) {
    if (existsSync(cur)) break;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  try { const s = statfsSync(cur); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

/** The folder(s) worktrees live in, one per project card (a `{repo}`-less worktreeDir collapses to one). */
function worktreeRoots(cfg: VladConfig): string[] {
  const roots = new Set<string>();
  for (const p of listProjects()) {
    try {
      const repo = projectPath(p.slug, cfg);
      roots.add(dirname(worktreePath(cfg, repo, "T00000000-0", process.platform as "win32" | "darwin" | "linux")));
    } catch { /* card without a resolvable path */ }
  }
  if (!roots.size && !cfg.worktreeDir.includes("{repo}")) roots.add(parse(cfg.worktreeDir).root ? cfg.worktreeDir : "");
  return [...roots].filter(Boolean);
}

/**
 * Free space of the worktree volume below `minFreeDiskGb` (default 20) ⇒ a warning line, with how many worktrees
 * `task cleanup --merged` would free. The (git-heavy) candidate scan only runs when the disk is low.
 */
export function diskWarning(
  cfg: VladConfig,
  o: { freeBytes?: (dir: string) => number | null; probe?: Pick<LivenessProbe, "alive">; project?: string } = {},
): DiskWarning | null {
  const thresholdGb = cfg.minFreeDiskGb ?? DEFAULT_MIN_FREE_DISK_GB;
  const free = o.freeBytes ?? volumeFreeBytes;
  let worst: { root: string; bytes: number } | null = null;
  for (const root of worktreeRoots(cfg)) {
    const b = free(root);
    if (b !== null && (!worst || b < worst.bytes)) worst = { root, bytes: b };
  }
  if (!worst || worst.bytes >= thresholdGb * 1024 ** 3) return null;
  let count = 0, bytes = 0;
  try {
    const r = cleanupMerged(cfg, { dryRun: true, ...(o.probe ? { probe: o.probe } : {}), ...(o.project ? { project: o.project } : {}), sizeBudgetMs: 3000 });
    for (const i of r.items) if (i.action === "remove") { count++; bytes += i.bytes ?? 0; }
  } catch { /* the warning itself matters more than the estimate */ }
  const freeGb = worst.bytes / 1024 ** 3;
  const text = `disk boş alanı ${freeGb.toFixed(1)} GB (eşik ${thresholdGb} GB; ${worst.root}); ` +
    (count ? `temizlenebilir ${count} worktree (~${humanBytes(bytes)}): \`vlad task cleanup --merged\`` : "temizlenebilir (merge edilmiş) worktree yok");
  return { freeGb, thresholdGb, root: worst.root, cleanable: { count, bytes }, text };
}
