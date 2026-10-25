import { resolveLaunchMode } from "../launcher/mode.js";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { isSeparateKb, kbPaths } from "./home.js";
import { missingIgnores, stageKb } from "./ignore.js";
import { assertGitOwner, kbMainBranch, pushWithMerge, resolvePushTarget } from "./sync.js";

export { KB_GITIGNORE } from "./ignore.js";

export interface KbCommitResult {
  committed: boolean;
  sha?: string;
  pushed?: boolean;
  /** Separate layout with --push: the branch the commits went to. */
  branch?: string;
  /** Separate layout with --push: origin/<main> was merged in first. */
  merged?: boolean;
  warning?: string;
}

/**
 * Commits the kb changes as `kb: <message>`.
 * Legacy layout (kb/ inside the VLAD repo): only the kb/ pathspec is committed, so code changes
 * (even staged ones) stay out; .gitignore keeps inbox/logs out.
 * Separate layout (kb is its own repo checkout, see `kbDir`): git runs in the kb root with pathspec
 * `.`; every commit there is a kb commit. A kb .gitignore missing the local-only entries yields a warning.
 * No changes → nothing is committed.
 *
 * With `push`, the branch is pushed to its upstream. In the legacy layout only if every unpushed
 * commit touches kb/ alone: the user pre-approved pushing memory, not code.
 * Separate layout: origin/<main> is fetched and merged first; a non-fast-forward rejection is retried once
 * (fetch + merge), then `kb_push_rejected`. A `kbPushBranch` (server machine) redirects the push to
 * `HEAD:refs/heads/<kbPushBranch>`; without it a `process`-launcher machine may not push (`kb_push_branch_required`).
 * Errors carry a code prefix (`kb_conflict`, `kb_push_branch_invalid`, `kb_separate_required`, `git_owner_mismatch`, ...).
 */
export function commitKb(message: string, o: { push?: boolean } = {}): KbCommitResult {
  if (!message.trim()) throw new Error("commit mesajı boş olamaz");
  const paths = kbPaths();
  const separate = isSeparateKb(paths.home);
  const cwd = separate ? paths.kb : paths.home;
  const spec = ["kb"];
  const r: KbCommitResult = { committed: false };
  assertGitOwner(cwd);
  if (separate) {
    const miss = missingIgnores(paths.kb);
    if (miss.length) r.warning = `kb .gitignore eksik: ${miss.join(", ")} ekle (yerel durum commit'lenmesin)`;
  }
  if (separate) stageKb((a) => git(cwd, a));
  else git(cwd, ["add", "--", ...spec]);
  // separate layout: everything staged is a kb commit; legacy: only the kb/ pathspec
  const only = separate ? [] : ["--", ...spec];
  if (git(cwd, ["diff", "--cached", "--name-only", ...only]).trim()) {
    git(cwd, ["commit", "-q", "-m", `kb: ${message.trim()}`, ...only]);
    r.committed = true;
    r.sha = git(cwd, ["rev-parse", "--short", "HEAD"]).trim();
  }
  if (!o.push) return r;
  if (separate) {
    const cfg = loadConfig(paths.home);
    const main = kbMainBranch(cwd);
    const target = resolvePushTarget(cwd, main, { pushBranch: cfg.kbPushBranch, serverMode: resolveLaunchMode(cfg.launcher) === "process" });
    const p = pushWithMerge(cwd, main, target.args);
    r.pushed = true;
    r.branch = target.branch;
    r.merged = p.merged;
    if (p.activeLost) r.warning = [r.warning, p.activeLost].filter(Boolean).join("; ");
    return r;
  }
  let legacyPushBranch: string | undefined;
  try {
    legacyPushBranch = loadConfig(paths.home).kbPushBranch; // legacy never needed a valid config: an unreadable one is not our error here
  } catch { /* ignore */ }
  if (legacyPushBranch) throw new Error("kb_separate_required: kbPushBranch (sunucu makinesi) yalnız ayrı kb deposunda (kbDir) kullanılır");
  // a fresh session branch has no upstream: everything on it is unpushed, and the first push sets it
  let upstream = true;
  try {
    git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    upstream = false;
  }
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  // "unpushed" = not reachable from any remote-tracking branch; `@{u}..HEAD` would also count code
  // commits that already sit on another remote branch (e.g. after ff-merging origin/master)
  const range = ["HEAD", "--not", "--remotes"];
  const outside = git(cwd, ["log", "--name-only", "--format=", ...range])
    .split(/\r?\n/).filter((f) => f && !f.startsWith("kb/"));
  if (outside.length) {
    r.pushed = false;
    r.warning = `push edilmedi: push edilmemiş commit'lerde kb dışı dosyalar var (${[...new Set(outside)].join(", ")}); bunlar onayla push edilir`;
    return r;
  }
  git(cwd, upstream ? ["push", "-q"] : ["push", "-q", "-u", "origin", branch]);
  r.pushed = true;
  return r;
}
