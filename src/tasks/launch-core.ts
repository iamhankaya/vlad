import { existsSync } from "node:fs";
import {
  addWorktree, attachWorktree, branchExists, isWorktree, remoteBranchExists, removeWorktree, runGit,
  worktreeBranch, worktreePath,
} from "../git/git.js";
import type { VladConfig } from "../kb/index.js";
import type { LaunchRequest, LaunchResult, Launcher } from "../launcher/index.js";
import { trustWorktree, untrustWorktree } from "./trust.js";

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
export async function launchCore(req: LaunchCoreReq, launcher: Launcher): Promise<LaunchCoreResult> {
  const { repo, worktree: wt, branch, base, branchOf, ...lr } = req;
  addWorktree(repo, wt, branch, base);
  // F-vlad-044: a worktree left on another branch (e.g. the integration branch) would let the worker commit past the gate
  const actual = (branchOf ?? worktreeBranch)(wt);
  if (actual !== branch) {
    try { removeWorktree(repo, wt); } catch { /* the branch cleanup and the error below still matter */ }
    // addWorktree refuses an existing branch, so `branch` (if present) was created just now; keep the name free for a retry
    if (branchExists(repo, branch)) runGit(repo, ["branch", "-D", branch]);
    throw new Error(`worktree beklenen faz dalında değil (beklenen ${branch}, bulunan ${actual ?? "yok"}): ${wt}`);
  }
  const created = runGit(repo, ["rev-parse", branch]);

  /** Rolls back worktree + branch; returns a description of what failed to clean up, or "". */
  const undo = (): string => {
    const problems: string[] = [];
    try {
      removeWorktree(repo, wt);
    } catch (e) {
      problems.push(`worktree kaldırılamadı (${wt}): ${(e as Error).message}`);
    }
    // the branch was created by addWorktree just now; drop it so a retry can reuse the name. Still at
    // its starting commit → nothing to lose, force it (-d refuses when the base is ahead of HEAD, as an
    // integration branch is); new commits on it → -d, which keeps unmerged work.
    const untouched = created !== null && runGit(repo, ["rev-parse", branch]) === created;
    if (runGit(repo, ["branch", untouched ? "-D" : "-d", branch]) === null) problems.push(`branch silinemedi: ${branch}`);
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
    const cleanup = undo();
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
  repo: string, parentId: string, cfg: VladConfig, defaultBranch?: string,
): { branch: string; worktree: string } {
  const branch = `vlad/${parentId}`;
  const worktree = worktreePath(cfg, repo, parentId);
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
