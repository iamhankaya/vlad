import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isSeparateKb, kbPaths } from "./home.js";

/** Lines a kb repo's .gitignore must carry (local-only state). */
export const KB_GITIGNORE = ["inbox/", "logs/", "vlad-session.txt", ".vlad.lock", ".obsidian/"];

function missingIgnores(kbDir: string): string[] {
  const file = join(kbDir, ".gitignore");
  const have = existsSync(file)
    ? new Set(readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim().replace(/^\//, "")))
    : new Set<string>();
  return KB_GITIGNORE.filter((l) => !have.has(l));
}

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", windowsHide: true });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} başarısız: ${(err.stderr || err.message).trim()}`);
  }
}

export interface KbCommitResult {
  committed: boolean;
  sha?: string;
  pushed?: boolean;
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
 */
export function commitKb(message: string, o: { push?: boolean } = {}): KbCommitResult {
  if (!message.trim()) throw new Error("commit mesajı boş olamaz");
  const paths = kbPaths();
  const separate = isSeparateKb(paths.home);
  const cwd = separate ? paths.kb : paths.home;
  const spec = separate ? "." : "kb";
  const r: KbCommitResult = { committed: false };
  if (separate) {
    const miss = missingIgnores(paths.kb);
    if (miss.length) r.warning = `kb .gitignore eksik: ${miss.join(", ")} ekle (yerel durum commit'lenmesin)`;
  }
  git(cwd, ["add", "--", spec]);
  if (git(cwd, ["diff", "--cached", "--name-only", "--", spec]).trim()) {
    git(cwd, ["commit", "-q", "-m", `kb: ${message.trim()}`, "--", spec]);
    r.committed = true;
    r.sha = git(cwd, ["rev-parse", "--short", "HEAD"]).trim();
  }
  if (!o.push) return r;
  // a fresh session branch has no upstream: everything on it is unpushed, and the first push sets it
  let upstream = true;
  try {
    git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    upstream = false;
  }
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (!separate) {
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
  }
  git(cwd, upstream ? ["push", "-q"] : ["push", "-q", "-u", "origin", branch]);
  r.pushed = true;
  return r;
}
