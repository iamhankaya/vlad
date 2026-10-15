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

/**
 * Commits the changes under kb/ in the VLAD home repo as `kb: <message>`. Only the kb/ pathspec is
 * committed, so code changes (even staged ones) stay out; .gitignore keeps inbox/logs out.
 * No changes under kb/ → nothing is committed.
 */
export function commitKb(message: string): { committed: boolean; sha?: string } {
  if (!message.trim()) throw new Error("commit mesajı boş olamaz");
  const home = kbPaths().home;
  git(home, ["add", "--", "kb"]);
  if (!git(home, ["diff", "--cached", "--name-only", "--", "kb"]).trim()) return { committed: false };
  git(home, ["commit", "-q", "-m", `kb: ${message.trim()}`, "--", "kb"]);
  return { committed: true, sha: git(home, ["rev-parse", "--short", "HEAD"]).trim() };
}
