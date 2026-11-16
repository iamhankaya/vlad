import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { runGitRaw, samePath, worktreePath } from "../git/git.js";
import type { VladConfig } from "../kb/index.js";
import { listProjects } from "../projects/store.js";
import { getTask } from "./store.js";
import { projectPath, removeTaskWorktree } from "./launch.js";

/**
 * `vlad worktree prune`: leftover folders under `<repo>-wt/` that git no longer lists. A folder qualifies only when
 * (a) no worktree of the project repo is registered there, (b) its name is a task ID, (c) that task is done/cancelled, (d) it holds nothing but `.remember`.
 * Running/queued/unknown tasks, registered worktrees, symlinks and roots whose `git worktree list` cannot be read are never touched.
 */
export type PruneItem = {
  project: string; id: string; dir: string;
  action: "delete" | "skip";
  /** why it is skipped */
  reason?: string;
  state?: string;
  /** set after a real deletion attempt */
  removed?: boolean;
  error?: string;
};
export type PruneResult = { dryRun: boolean; items: PruneItem[]; removed: number; errors: number };

const TASK_DIR = /^T\d{8}-\d+$/;
const isInside = (root: string, p: string): boolean => {
  try {
    const rel = relative(realpathSync.native(root), realpathSync.native(p));
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  } catch { return false; }
};

export function pruneOrphanWorktrees(
  cfg: VladConfig,
  o: { yes: boolean },
  seam: { remove?: (repo: string, dir: string, id: string) => void } = {},
): PruneResult {
  const remove = seam.remove ?? removeTaskWorktree;
  const items: PruneItem[] = [];
  // a worktreeDir without {repo} is shared by every project: group repos by the root they use
  const roots = new Map<string, { slug: string; repo: string }[]>();
  const shared = !cfg.worktreeDir.includes("{repo}");
  // a project whose repo cannot be resolved may still own registered worktrees in a shared root: that root is unsafe
  let unresolved = false;
  const repoOf = new Map<PruneItem, string>();
  for (const p of listProjects()) {
    let repo: string;
    try { repo = projectPath(p.slug, cfg); } catch { unresolved = true; continue; }
    if (!existsSync(repo)) { unresolved = true; continue; }
    const root = dirname(worktreePath(cfg, repo, "T00000000-0", process.platform as "win32" | "darwin" | "linux"));
    roots.set(root, [...(roots.get(root) ?? []), { slug: p.slug, repo }]);
  }
  for (const [root, repos] of roots) {
    if (!existsSync(root)) continue;
    // registered anywhere = not an orphan; an unreadable list makes the whole root unsafe (everything would look unregistered)
    // `-z`: NUL-separated fields, paths literal (no quoting/escaping of non-ASCII or newline), compared as they are
    const listed = repos.map((r) => runGitRaw(r.repo, ["worktree", "list", "--porcelain", "-z"]));
    const unreadable = listed.some((l) => l === null) || (shared && unresolved);
    const registered = (dir: string): boolean =>
      listed.some((l) => (l ?? "").split("\0").some((f) => f.startsWith("worktree ") && samePath(f.slice(9), dir)));
    for (const name of readdirSync(root).sort()) {
      if (!TASK_DIR.test(name)) continue;
      const dir = join(root, name);
      const base = { project: repos[0]!.slug, id: name, dir };
      let st;
      try { st = lstatSync(dir); } catch { continue; }
      if (st.isSymbolicLink()) { items.push({ ...base, action: "skip", reason: "sembolik bağlantı" }); continue; }
      if (!st.isDirectory()) continue;
      if (unreadable) { items.push({ ...base, action: "skip", reason: "git worktree list okunamadı ya da bir projenin repo yolu çözülemedi" }); continue; }
      if (registered(dir)) { items.push({ ...base, action: "skip", reason: "kayıtlı worktree" }); continue; }
      let state: string;
      try { state = getTask(name).data.state; } catch { items.push({ ...base, action: "skip", reason: "görev bulunamadı" }); continue; }
      if (state !== "done" && state !== "cancelled") { items.push({ ...base, state, action: "skip", reason: `görev ${state}` }); continue; }
      // (d) conservative: only a stub holding nothing but `.remember` is deleted; anything else may be someone's work
      let names: string[];
      try { names = readdirSync(dir); } catch { items.push({ ...base, state, action: "skip", reason: "klasör okunamadı" }); continue; }
      if (names.some((n) => n !== ".remember")) { items.push({ ...base, state, action: "skip", reason: "içerik var, atlandı" }); continue; }
      if (!isInside(root, dir)) { items.push({ ...base, state, action: "skip", reason: "klasör kökün dışına çözülüyor" }); continue; }
      const item: PruneItem = { ...base, state, action: "delete" };
      repoOf.set(item, repos[0]!.repo);
      items.push(item);
    }
  }
  let removed = 0, errors = 0;
  if (o.yes) {
    for (const it of items.filter((i) => i.action === "delete")) {
      const repo = repoOf.get(it)!;
      try {
        remove(repo, it.dir, it.id);
        if (existsSync(it.dir)) throw new Error("klasör hâlâ duruyor");
        it.removed = true; removed++;
      } catch (e) { it.error = (e as Error).message; errors++; }
    }
  }
  return { dryRun: !o.yes, items, removed, errors };
}
