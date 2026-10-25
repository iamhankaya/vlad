import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Lines a kb repo's .gitignore must carry (local-only state). */
export const KB_GITIGNORE = ["inbox/", "logs/", "vlad-session.txt", ".vlad.lock", "cards/*.lock"];

/**
 * Paths kb commits never stage, whatever .gitignore says (security review O3). Not an `:(exclude)` pathspec:
 * `git add` refuses excluded paths that are ignored, so they are unstaged after `add -A` instead.
 */
export const KB_LOCAL_ONLY = ["logs", "inbox", "cards/*.lock", ".vlad.lock", "vlad-session.txt"];

/** `git add -A` for the kb, then unstage the local-only paths. */
export function stageKb(git: (args: string[]) => string): void {
  git(["add", "-A", "--", "."]);
  git(["reset", "-q", "--", ...KB_LOCAL_ONLY]);
}

export function missingIgnores(kbDir: string): string[] {
  const file = join(kbDir, ".gitignore");
  const have = existsSync(file)
    ? new Set(readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim().replace(/^\//, "")))
    : new Set<string>();
  return KB_GITIGNORE.filter((l) => !have.has(l));
}
