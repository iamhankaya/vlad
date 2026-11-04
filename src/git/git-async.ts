import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { samePath, unlinkReparsePoints } from "./git.js";

/**
 * Async twins of the git helpers a worker Agent uses while serving a request (launch/resume): the Agent's event
 * loop keeps answering pings while a slow `git fetch`/`worktree add` runs. Same semantics as `git.ts`.
 */
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

export function runGitRawAsync(cwd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, encoding: "utf8", windowsHide: true, env: ENV, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}
export const runGitAsync = async (cwd: string, args: string[], timeoutMs = 3000): Promise<string | null> => (await runGitRawAsync(cwd, args, timeoutMs))?.trim() ?? null;

export function mustGitAsync(cwd: string, args: string[], timeoutMs = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, encoding: "utf8", windowsHide: true, env: ENV, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} başarısız: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

export const branchExistsAsync = async (repo: string, branch: string): Promise<boolean> =>
  (await runGitAsync(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== null;

export async function remoteBranchExistsAsync(repo: string, branch: string): Promise<boolean> {
  await runGitAsync(repo, ["fetch", "--quiet", "origin", branch], 30000);
  return (await runGitAsync(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])) !== null;
}

export async function worktreeBranchAsync(dir: string): Promise<string | null> {
  const b = await runGitAsync(dir, ["branch", "--show-current"]);
  return b ? b : null;
}

export async function addWorktreeAsync(repo: string, dir: string, branch: string, base?: string): Promise<void> {
  if (existsSync(dir)) throw new Error(`zaten var: ${dir}`);
  if (await branchExistsAsync(repo, branch)) throw new Error(`zaten var: ${branch}`);
  const start = await runGitAsync(repo, ["rev-parse", base ?? "HEAD"]);
  try {
    await mustGitAsync(repo, ["worktree", "add", "-b", branch, dir, ...(base ? [base] : [])]);
  } catch (e) {
    // F-vlad-198: same rollback as the sync twin
    if (start && (await runGitAsync(repo, ["rev-parse", `refs/heads/${branch}`])) === start) await runGitAsync(repo, ["branch", "-D", branch]);
    throw e;
  }
}

export async function attachWorktreeAsync(repo: string, dir: string, branch: string): Promise<void> {
  if (existsSync(dir)) throw new Error(`zaten var: ${dir}`);
  await runGitAsync(repo, ["worktree", "prune"]);
  await mustGitAsync(repo, ["worktree", "add", dir, branch]);
}

export async function removeWorktreeAsync(repo: string, dir: string): Promise<void> {
  if (existsSync(dir)) unlinkReparsePoints(dir);
  await mustGitAsync(repo, ["worktree", "remove", "--force", dir]);
}

export async function isWorktreeAsync(repo: string, dir: string): Promise<boolean> {
  const out = (await runGitAsync(repo, ["worktree", "list", "--porcelain"])) ?? "";
  return out.split("\n").some((l) => l.startsWith("worktree ") && samePath(l.slice(9), dir));
}
