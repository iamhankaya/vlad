import { existsSync } from "node:fs";
import {
  addWorktree, attachWorktree, branchExists, isWorktree, remoteBranchExists, removeWorktree, runGit,
  worktreeBranch, worktreePath,
} from "../git/git.js";
import type { VladConfig } from "../kb/index.js";
import type { LaunchRequest, LaunchResult, Launcher } from "../launcher/index.js";
import {
  addWorktreeAsync, attachWorktreeAsync, branchExistsAsync, isWorktreeAsync, remoteBranchExistsAsync, removeWorktreeAsync,
  runGitAsync, worktreeBranchAsync,
} from "../git/git-async.js";
import { trustWorktree, untrustWorktree } from "./trust.js";

/** Path separator style of the machine the worktree lives on (F-vlad-148: never assume win32). */
type HostOs = "win32" | "darwin" | "linux";
type Maybe<T> = T | Promise<T>;
/** The git calls a launch makes. The brain uses the sync set (default); a worker Agent the async one so its event loop stays free. */
export interface GitApi {
  addWorktree(repo: string, dir: string, branch: string, base?: string): Maybe<void>;
  attachWorktree(repo: string, dir: string, branch: string): Maybe<void>;
  worktreeBranch(dir: string): Maybe<string | null>;
  removeWorktree(repo: string, dir: string): Maybe<void>;
  branchExists(repo: string, branch: string): Maybe<boolean>;
  remoteBranchExists(repo: string, branch: string): Maybe<boolean>;
  isWorktree(repo: string, dir: string): Maybe<boolean>;
  runGit(cwd: string, args: string[]): Maybe<string | null>;
}
export const SYNC_GIT: GitApi = { addWorktree, attachWorktree, worktreeBranch, removeWorktree, branchExists, remoteBranchExists, isWorktree, runGit: (c, a) => runGit(c, a) };
export const ASYNC_GIT: GitApi = {
  addWorktree: addWorktreeAsync, attachWorktree: attachWorktreeAsync, worktreeBranch: worktreeBranchAsync, removeWorktree: removeWorktreeAsync,
  branchExists: branchExistsAsync, remoteBranchExists: remoteBranchExistsAsync, isWorktree: isWorktreeAsync, runGit: (c, a) => runGitAsync(c, a),
};

/**
 * The kb-free core of a launch (machines C1): worktree + branch + folder trust + launcher, with the
 * rollback on failure. Brain and worker run the same code; kb writes (task state, errors, reservations)
 * stay with the brain. `base`: branch the new branch starts from (a pipeline phase: the integration branch).
 */
export interface LaunchCoreReq extends Omit<LaunchRequest, "cwd"> {
  repo: string;
  worktree: string;
  branch: string;
  base?: string;
  /** test seam: the branch a worktree sits on (default: git) */
  branchOf?: (worktree: string) => string | null;
}
export type LaunchCoreResult = LaunchResult & { branch: string; worktree: string };

/** Throws with the same messages the pre-split `launchTask` recorded; the caller records the error. */
export async function launchCore(req: LaunchCoreReq, launcher: Launcher, g: GitApi = SYNC_GIT): Promise<LaunchCoreResult> {
  const { repo, worktree: wt, branch, base, branchOf, ...lr } = req;
  // F-vlad-239: a failed task re-queued for a retry keeps its worktree/branch (the worker's commits). Re-adopt them only when
  // the owner checks out: the folder is a git worktree sitting on exactly `branch`, or only the branch is left. Anything else
  // (foreign folder, other branch) falls through to addWorktree, which refuses with "zaten var".
  let reused = false;
  if (existsSync(wt)) {
    reused = (await g.isWorktree(repo, wt)) && (await (branchOf ?? g.worktreeBranch)(wt)) === branch;
  } else if (await g.branchExists(repo, branch)) {
    await g.attachWorktree(repo, wt, branch);
    reused = true;
  }
  if (!reused) await g.addWorktree(repo, wt, branch, base);
  // F-vlad-044: a worktree left on another branch (e.g. the integration branch) would let the worker commit past the gate
  const actual = await (branchOf ?? g.worktreeBranch)(wt);
  if (actual !== branch) {
    try { await g.removeWorktree(repo, wt); } catch { /* the branch cleanup and the error below still matter */ }
    // addWorktree refuses an existing branch, so `branch` (if present) was created just now; keep the name free for a retry
    if (await g.branchExists(repo, branch)) await g.runGit(repo, ["branch", "-D", branch]);
    throw new Error(`worktree beklenen faz dalında değil (beklenen ${branch}, bulunan ${actual ?? "yok"}): ${wt}`);
  }
  const created = await g.runGit(repo, ["rev-parse", branch]);

  /** Rolls back worktree + branch; returns a description of what failed to clean up, or "". */
  const undo = async (): Promise<string> => {
    const problems: string[] = [];
    try {
      await g.removeWorktree(repo, wt);
    } catch (e) {
      problems.push(`worktree kaldırılamadı (${wt}): ${(e as Error).message}`);
    }
    // the branch was created by addWorktree just now; drop it so a retry can reuse the name. Still at
    // its starting commit → nothing to lose, force it (-d refuses when the base is ahead of HEAD, as an
    // integration branch is); new commits on it → -d, which keeps unmerged work.
    const untouched = created !== null && (await g.runGit(repo, ["rev-parse", branch])) === created;
    if ((await g.runGit(repo, ["branch", untouched ? "-D" : "-d", branch])) === null) problems.push(`branch silinemedi: ${branch}`);
    return problems.join("; ");
  };

  // a worktree missing from ~/.claude.json parks the worker on the "Quick safety check" screen
  const trustWarning = trustWorktree(wt);
  if (trustWarning) console.error(`uyarı: ${trustWarning}`);

  let failure: string | null = null;
  let res: LaunchResult | undefined;
  try {
    res = await launcher.launch({ ...lr, cwd: wt });
    if (!res.ok) failure = `launcher başarısız (${res.method}): ${res.detail ?? "bilinmeyen hata"}`;
  } catch (e) {
    failure = `launcher başarısız: ${(e as Error).message}`;
  }
  if (failure || !res) {
    if (reused) throw new Error(failure!); // the earlier run's commits live here: never roll back what this launch did not create
    const cleanup = await undo();
    untrustWorktree(wt);
    throw new Error(`${failure}${cleanup ? `; temizlik başarısız: ${cleanup}` : ""}`);
  }
  return { ...res, branch, worktree: wt };
}

/**
 * Git half of `ensureIntegration` (pipeline spec §6): makes sure `vlad/<parent>` and its worktree exist in
 * `repo`. A missing local branch is tracked from `origin/vlad/<parent>` if that exists, else cut from
 * `defaultBranch` (HEAD when unset or absent). Touches no kb.
 */
export function ensureIntegrationGit(
  repo: string, parentId: string, cfg: VladConfig, defaultBranch?: string, os: HostOs = process.platform as HostOs,
): { branch: string; worktree: string } {
  const branch = `vlad/${parentId}`;
  const worktree = worktreePath(cfg, repo, parentId, os);
  if (!branchExists(repo, branch)) {
    if (remoteBranchExists(repo, branch)) addWorktree(repo, worktree, branch, `origin/${branch}`);
    else addWorktree(repo, worktree, branch, defaultBranch && branchExists(repo, defaultBranch) ? defaultBranch : undefined);
  } else if (!existsSync(worktree)) attachWorktree(repo, worktree, branch);
  else if (!isWorktree(repo, worktree)) {
    // a merge into it at the gate would fail or, inside the repo, hit the wrong branch
    throw new Error(`entegrasyon klasörü bir git worktree'si değil: ${worktree}; klasörü kaldırıp tekrar dene`);
  }
  return { branch, worktree };
}

/** `ensureIntegrationGit` over a `GitApi` (a worker Agent's async git). */
export async function ensureIntegrationGitWith(
  g: GitApi, repo: string, parentId: string, cfg: VladConfig, defaultBranch?: string, os: HostOs = process.platform as HostOs,
): Promise<{ branch: string; worktree: string }> {
  const branch = `vlad/${parentId}`;
  const worktree = worktreePath(cfg, repo, parentId, os);
  if (!(await g.branchExists(repo, branch))) {
    if (await g.remoteBranchExists(repo, branch)) await g.addWorktree(repo, worktree, branch, `origin/${branch}`);
    else await g.addWorktree(repo, worktree, branch, defaultBranch && (await g.branchExists(repo, defaultBranch)) ? defaultBranch : undefined);
  } else if (!existsSync(worktree)) await g.attachWorktree(repo, worktree, branch);
  else if (!(await g.isWorktree(repo, worktree))) {
    throw new Error(`entegrasyon klasörü bir git worktree'si değil: ${worktree}; klasörü kaldırıp tekrar dene`);
  }
  return { branch, worktree };
}
