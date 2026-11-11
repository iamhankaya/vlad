import { spawnSync } from "node:child_process";
import { BRANCH_PUSH_BRANCH_RE, BRANCH_PUSH_REMOTE, BRANCH_PUSH_TIMEOUT_MS, RemoteError, type BranchPushArgs, type BranchPushReason, type BranchPushResult } from "../../fleet/types.js";
import type { Reconciler, Verdict } from "../reconcile.js";
import { runGit, serialized, taskFront } from "./gate.js";
import { verifiedRecord } from "./launch.js";
import { argObject, bad, projectArg, repoNameArg, taskIdArg, workerCtx } from "./worker.js";

// `branch-push` (F-vlad-314, D-vlad-076): işçi Agent'ı yalnız görevin kendi `vlad/<id>` dalını, gate'lenen sha'ya kilitli olarak origin'e iter.
// Push argv'sinde `+`/force/tags/mirror/all/delete asla yok: hedef `origin <expectHead>:refs/heads/vlad/<id>`.

const ARGS = ["taskId", "project", "repoName", "branch", "expectHead"] as const;

/** İstek şeması: yalnız bu 5 alan; branch tam `vlad/<taskId>`; expectHead 40 haneli küçük harf sha. */
export function parseBranchPushArgs(args: unknown): BranchPushArgs {
  const a = argObject(args, ARGS);
  const taskId = taskIdArg(a);
  const project = projectArg(a);
  const repoName = repoNameArg(a);
  if (typeof a.branch !== "string" || !BRANCH_PUSH_BRANCH_RE.test(a.branch) || a.branch !== `vlad/${taskId}`) throw bad("branch görevin kendi dalı (vlad/<taskId>) olmalı");
  if (typeof a.expectHead !== "string" || !/^[0-9a-f]{40}$/.test(a.expectHead)) throw bad("expectHead 40 haneli sha olmalı");
  return { taskId, project, repoName, branch: a.branch, expectHead: a.expectHead };
}

/** git push argv'si: tek refspec (`+` yok), etiket yok. Testte birebir doğrulanır. */
export const branchPushArgv = (branch: string, head: string): string[] => ["push", "--porcelain", "--no-follow-tags", BRANCH_PUSH_REMOTE, `${head}:refs/heads/${branch}`];

const fail = (reason: BranchPushReason, m: string) => new RemoteError("failed", `failed: [${reason}] ${m}`);
const AUTH = /authenticat|could not read (username|password)|permission denied|access denied|\b40[13]\b|terminal prompts disabled/i;
/** stderr'in ilk satırı; uzak URL/yol "origin" ile değiştirilir (sızıntı yok). */
const firstLine = (s: string, url: string): string => {
  const l = s.trim().split("\n")[0] ?? "";
  return (url ? l.split(url).join("origin") : l).slice(0, 200); // önce URL'yi sansürle, sonra kes
};
const lsRemoteSha = (stdout: string): string => stdout.trim().split(/\s+/)[0] ?? "";

export async function pushTaskBranch(repo: string, id: string, expectHead: string): Promise<BranchPushResult> {
  const branch = `vlad/${id}`;
  const ref = `refs/heads/${branch}`;
  const done = (pushed: boolean): BranchPushResult => ({ branch, head: expectHead, pushed, remote: BRANCH_PUSH_REMOTE });
  const tip = (await runGit(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.trim();
  if (!tip) throw new RemoteError("not_found", `not_found: dal yok: ${branch}`);
  if (tip !== expectHead) throw fail("stale_tip", `${branch} ucu (${tip.slice(0, 7)}) gate'lenen sha'dan (${expectHead.slice(0, 7)}) farklı; gate'i yeniden koş`);
  const url = (await runGit(repo, ["remote", "get-url", BRANCH_PUSH_REMOTE])).stdout.trim();
  if (!url) throw fail("no_origin", "işçi reposunda origin tanımlı değil");
  const remoteSha = async (): Promise<string> => {
    const r = await runGit(repo, ["ls-remote", BRANCH_PUSH_REMOTE, ref], BRANCH_PUSH_TIMEOUT_MS);
    if (r.code !== 0) throw fail(AUTH.test(r.stderr) ? "auth" : "no_origin", `origin'e ulaşılamadı: ${firstLine(r.stderr, url)}`);
    return lsRemoteSha(r.stdout);
  };
  return serialized(repo, async () => {
    const before = await remoteSha();
    if (before === expectHead) return done(false);
    // origin'deki uç yerelin atası değilse (ya da yerelde yoksa) ayrışmış sayılır: force yok
    if (before && (await runGit(repo, ["merge-base", "--is-ancestor", before, expectHead])).code !== 0) throw new RemoteError("conflict", `conflict: [diverged] origin'deki ${branch} ucu (${before.slice(0, 7)}) gate'lenen sha'nın atası değil; push yapılmadı`);
    const p = await runGit(repo, branchPushArgv(branch, expectHead), BRANCH_PUSH_TIMEOUT_MS);
    if (p.code !== 0) throw fail(AUTH.test(p.stderr) ? "auth" : "push_rejected", `push başarısız: ${firstLine(p.stderr || p.stdout, url)}`);
    if ((await remoteSha()) !== expectHead) throw fail("push_rejected", "push sonrası origin ucu beklenen sha değil");
    return done(true);
  });
}

/** Op gövdesi: şema → görev dosyası (machine===self) → başlatma kaydı → push. Yol/URL istekten gelmez. */
export async function branchPushOp(args: unknown): Promise<BranchPushResult> {
  const a = parseBranchPushArgs(args);
  const ctx = workerCtx();
  taskFront(ctx, a.taskId, a.project);
  const { repo } = verifiedRecord(ctx, a.taskId, a.repoName);
  return pushTaskBranch(repo, a.taskId, a.expectHead);
}

/** `started` kalmış push'un etkisi var mı? origin'de dal expectHead ise uygulanmıştır; yoksa güvenle yeniden denenir; başka sha/hata → unknown. */
export function branchPushVerdict(repo: string, branch: string, expectHead: string): Verdict | { verdict: "applied"; result: BranchPushResult } {
  const r = spawnSync("git", ["ls-remote", BRANCH_PUSH_REMOTE, `refs/heads/${branch}`], { cwd: repo, encoding: "utf8", windowsHide: true, timeout: BRANCH_PUSH_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) return "unknown";
  const sha = lsRemoteSha(r.stdout ?? "");
  if (!sha) return "not-applied";
  // başka (eski) uç: push uygulanmadı; pushTaskBranch idempotent olduğundan yeniden denemek güvenli
  return sha === expectHead ? { verdict: "applied", result: { branch, head: expectHead, pushed: true, remote: BRANCH_PUSH_REMOTE } } : "not-applied";
}

export const reconcileBranchPush: Reconciler = (rec) => {
  const a = parseBranchPushArgs(rec.args);
  const ctx = workerCtx();
  const { repo } = verifiedRecord(ctx, a.taskId, a.repoName);
  return branchPushVerdict(repo, a.branch, a.expectHead);
};
