import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { VladConfig } from "../kb/index.js";

/** Runs git; returns untrimmed stdout, or null on error/timeout. */
export function runGitRaw(cwd: string, args: string[], timeoutMs = 3000): string | null {
  try {
    return execFileSync("git", args, {
      cwd, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** Runs git; returns trimmed stdout, or null on error/timeout. */
export function runGit(cwd: string, args: string[], timeoutMs = 3000): string | null {
  return runGitRaw(cwd, args, timeoutMs)?.trim() ?? null;
}

export function isRepo(cwd: string): boolean {
  return runGit(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

export function currentBranch(cwd: string): string | null {
  const b = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return b ? b : null;
}

export function headSha(cwd: string): string | null {
  const s = runGit(cwd, ["rev-parse", "HEAD"]);
  return s ? s : null;
}

export function recentCommits(
  cwd: string, sinceIso: string | null, max = 20,
): { sha: string; subject: string; date: string }[] {
  const args = ["log", `--max-count=${max}`, "--format=%H%x1f%s%x1f%aI"];
  if (sinceIso) args.push(`--since=${sinceIso}`);
  const out = runGit(cwd, args);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((l) => {
    const [sha, subject, date] = l.split("\x1f");
    return { sha, subject, date };
  });
}

/** Working-tree changes (status --porcelain) union files of the last commit. */
export function changedFiles(cwd: string): string[] {
  const set = new Set<string>();
  // runGit trims, which would eat the leading status column; use the raw variant.
  const status = runGitRaw(cwd, ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"]) ?? "";
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    set.add(p.replace(/^"|"$/g, ""));
  }
  const last = runGit(cwd, ["-c", "core.quotepath=false", "show", "--name-only", "--format=", "HEAD"]);
  for (const f of last?.split("\n") ?? []) if (f) set.add(f);
  return [...set];
}

export function worktreePath(cfg: VladConfig, repoPath: string, taskId: string): string {
  const base = cfg.worktreeDir.split("{repo}").join(repoPath);
  return `${base.replace(/[\\/]+$/, "")}\\${taskId}`;
}

function mustGit(cwd: string, args: string[]): void {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", windowsHide: true });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} başarısız: ${(err.stderr || err.message).trim()}`);
  }
}

export function addWorktree(repo: string, dir: string, branch: string): void {
  if (existsSync(dir)) throw new Error(`zaten var: ${dir}`);
  if (runGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null) {
    throw new Error(`zaten var: ${branch}`);
  }
  mustGit(repo, ["worktree", "add", "-b", branch, dir]);
}

export function removeWorktree(repo: string, dir: string): void {
  mustGit(repo, ["worktree", "remove", "--force", dir]);
}
