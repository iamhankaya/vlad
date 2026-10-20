import { execFileSync } from "node:child_process";
import { kbPaths } from "./home.js";

function git(cwd: string, args: string[]): string {
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
 * Commits the changes under kb/ in the VLAD home repo as `kb: <message>`. Only the kb/ pathspec is
 * committed, so code changes (even staged ones) stay out; .gitignore keeps inbox/logs out.
 * No changes under kb/ → nothing is committed.
 *
 * With `push`, the branch is pushed to its upstream, but only if every unpushed commit touches kb/
 * alone: the user pre-approved pushing memory, not code.
 */
export function commitKb(message: string, o: { push?: boolean } = {}): KbCommitResult {
  if (!message.trim()) throw new Error("commit mesajı boş olamaz");
  const home = kbPaths().home;
  git(home, ["add", "--", "kb"]);
  const r: KbCommitResult = { committed: false };
  if (git(home, ["diff", "--cached", "--name-only", "--", "kb"]).trim()) {
    git(home, ["commit", "-q", "-m", `kb: ${message.trim()}`, "--", "kb"]);
    r.committed = true;
    r.sha = git(home, ["rev-parse", "--short", "HEAD"]).trim();
  }
  if (!o.push) return r;
  // a fresh session branch has no upstream: everything on it is unpushed, and the first push sets it
  let upstream = true;
  try {
    git(home, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    upstream = false;
  }
  const branch = git(home, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  // "unpushed" = not reachable from any remote-tracking branch; `@{u}..HEAD` would also count code
  // commits that already sit on another remote branch (e.g. after ff-merging origin/master)
  const range = ["HEAD", "--not", "--remotes"];
  const outside = git(home, ["log", "--name-only", "--format=", ...range])
    .split(/\r?\n/).filter((f) => f && !f.startsWith("kb/"));
  if (outside.length) {
    r.pushed = false;
    r.warning = `push edilmedi: push edilmemiş commit'lerde kb dışı dosyalar var (${[...new Set(outside)].join(", ")}); bunlar onayla push edilir`;
    return r;
  }
  git(home, upstream ? ["push", "-q"] : ["push", "-q", "-u", "origin", branch]);
  r.pushed = true;
  return r;
}
