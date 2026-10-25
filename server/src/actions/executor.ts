import { APPROVED_CHECK, type CheckRun, type GithubReader, type PullFacts } from "./github.ts";
import { advance } from "./advance.ts";
import type { VladOps } from "./ops.ts";
import { ActionError, type ActionDescriptor, type ApprovalProof, type ExecuteAction, type ExecuteContext, type TaskSource } from "./service.ts";
import type { GithubWriter } from "../github/writer.ts";
import type { EventType } from "../events/ledger.ts";

export type ExecutorDeps = {
  reader: GithubReader;
  writer: GithubWriter;
  tasks: TaskSource;
  ops: VladOps;
  /** `EventLedger.append`; the event is keyed by action id, so a retry never doubles it. */
  appendEvent: (type: EventType, data: Record<string, unknown>, key: string) => unknown;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The GitHub App's id: only a `vlad/approved` run it wrote counts (when the response names the app). */
  appId?: number;
  /** Login that must have merged an already merged PR for it to count as ours (e.g. `vlad-gate[bot]`). */
  mergerLogin?: string;
  /** Learns that login when `mergerLogin` is not configured (`GET /app` slug + `[bot]`). Without either, a merged PR is never claimed. */
  resolveMergerLogin?: () => Promise<string | undefined>;
  /** Longest wait for `blocked` to clear after the check-run is written. Default 10 000 ms. */
  blockedWaitMs?: number;
  pollMs?: number;
  log?: (msg: string) => void;
};

export const BLOCKED_WAIT_MS = 10_000;
export const POLL_MS = 1_000;
const UNKNOWN_ATTEMPTS = 3;
const UNKNOWN_WAIT_MS = 2_000;
const CLEAN = new Set(["clean", "has_hooks"]);

/**
 * The single exit of the approval path. Order (each step safe to repeat, so a retry of a `checked` action resumes):
 * live look at the PR -> `vlad/approved` check-run (once) -> wait until `blocked` clears -> `stillAuthorized()` ->
 * `PUT merge` with `sha: head_sha` -> audit (keyed by action_id) -> `vlad task set done` -> advance -> `action.executed`.
 * Everything after the merge is bookkeeping: the merge is never repeated, and a failure there is retried by the next approve.
 */
export function createExecutor(d: ExecutorDeps): ExecuteAction {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const blockedWait = d.blockedWaitMs ?? BLOCKED_WAIT_MS;
  const poll = d.pollMs ?? POLL_MS;

  // With an app id known only a run THAT app wrote counts; a run without `app_id` does not.
  const ours = (r: CheckRun) => r.name === APPROVED_CHECK && r.conclusion === "success" && r.status === "completed" && (d.appId === undefined || r.app_id === d.appId);

  async function upstream<T>(fn: () => Promise<T>, reason = "github_unavailable"): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ActionError) throw e;
      d.log?.(`${reason}: ${(e as Error).message}`);
      throw new ActionError(502, "bad_request", reason);
    }
  }

  async function livePull(a: ActionDescriptor): Promise<PullFacts> {
    const pull = await upstream(() => d.reader.getPull(a.repo, a.pr));
    if (!pull) throw new ActionError(409, "not_mergeable", "pr_not_found");
    return pull;
  }

  /**
   * Repo, base and head must be what the signed challenge says, on every look: a PR re-targeted while we wait (base moved to
   * the main branch) must never be merged under a `merge_phase` approval.
   */
  function checkOrigin(a: ActionDescriptor, pull: PullFacts) {
    if (pull.base.ref !== a.base || pull.base.repo !== a.repo) throw new ActionError(409, "not_mergeable", "base_mismatch");
    if (pull.head.ref !== `vlad/${a.task}` || pull.head.repo !== a.repo) throw new ActionError(409, "not_mergeable", "head_ref_mismatch");
  }

  /** The PR is merged already (an earlier attempt got that far). It is ours only for the approved head, the same origin and OUR merger; unknown merger = not ours. */
  async function adoptMerged(a: ActionDescriptor, pull: PullFacts): Promise<string> {
    checkOrigin(a, pull);
    if (pull.head.sha !== a.head_sha || !pull.merge_commit_sha) throw new ActionError(409, "head_moved", "head_moved");
    const login = d.mergerLogin ?? (await d.resolveMergerLogin?.().catch(() => undefined));
    if (!login) throw new ActionError(409, "not_mergeable", "merger_unknown");
    if (pull.merged_by !== login) throw new ActionError(409, "not_mergeable", "merged_by_other");
    return pull.merge_commit_sha;
  }

  async function ensureApprovedRun(a: ActionDescriptor): Promise<void> {
    const runs = await upstream(() => d.reader.getCheckRuns(a.repo, a.head_sha));
    if (runs.some(ours)) return;
    await upstream(() => d.writer.writeApproved(a.repo, a.head_sha, `Onaylanan: ${a.task}, PR #${a.pr}, ${a.head_sha.slice(0, 12)}`));
  }

  /** After the check-run: wait (at most `blockedWait`) for `blocked` to clear; `unknown` gets three looks. Anything else but clean is final. */
  async function waitMergeable(a: ActionDescriptor): Promise<PullFacts> {
    let waited = 0;
    let unknown = 0;
    for (;;) {
      const pull = await livePull(a);
      if (pull.merged) return pull;
      if (pull.state !== "open" || pull.draft) throw new ActionError(409, "not_mergeable", pull.draft ? "draft" : "pr_closed");
      if (pull.head.sha !== a.head_sha) throw new ActionError(409, "head_moved", "head_moved");
      checkOrigin(a, pull);
      const s = pull.mergeable_state;
      if (pull.mergeable === true && CLEAN.has(s)) return pull;
      if (pull.mergeable === null || s === "unknown") {
        if (++unknown >= UNKNOWN_ATTEMPTS) throw new ActionError(409, "not_mergeable", "mergeable_unknown");
        await sleep(UNKNOWN_WAIT_MS);
        continue;
      }
      if (s === "blocked" && waited < blockedWait) {
        await sleep(poll);
        waited += poll;
        continue;
      }
      throw new ActionError(409, "not_mergeable", s === "dirty" ? "conflict" : s === "blocked" ? "blocked" : s === "behind" ? "behind" : `state_${s}`);
    }
  }

  return async (a: ActionDescriptor, approval: ApprovalProof, ctx?: ExecuteContext) => {
    // Asked before every outward step, not just the last: a revoked device or a changed task writes nothing, not even the check-run.
    const authorized = async () => {
      if (ctx && !(await ctx.stillAuthorized())) throw new ActionError(410, "expired", "revoked");
    };
    let mergeSha: string;
    const first = await livePull(a);
    if (first.merged) {
      mergeSha = await adoptMerged(a, first);
    } else {
      if (first.state !== "open" || first.draft) throw new ActionError(409, "not_mergeable", first.draft ? "draft" : "pr_closed");
      if (first.head.sha !== a.head_sha) throw new ActionError(409, "head_moved", "head_moved");
      checkOrigin(a, first);
      await authorized();
      await ensureApprovedRun(a);
      let pull = await waitMergeable(a);
      if (!pull.merged) {
        // Order of the last steps: still authorized -> one more look (origin, head, state) -> PUT.
        await authorized();
        pull = await livePull(a);
        if (!pull.merged) {
          if (pull.state !== "open" || pull.draft) throw new ActionError(409, "not_mergeable", pull.draft ? "draft" : "pr_closed");
          if (pull.head.sha !== a.head_sha) throw new ActionError(409, "head_moved", "head_moved");
          checkOrigin(a, pull);
          if (!(pull.mergeable === true && CLEAN.has(pull.mergeable_state))) throw new ActionError(409, "not_mergeable", `state_${pull.mergeable_state}`);
        }
      }
      if (pull.merged) {
        mergeSha = await adoptMerged(a, pull);
      } else {
        const out = await upstream(() => d.writer.merge(a.repo, a.pr, a.head_sha));
        if (out.kind === "head_moved") throw new ActionError(409, "head_moved", "head_moved");
        if (out.kind === "not_mergeable") throw new ActionError(409, "not_mergeable", "github_refused", { message: out.message });
        mergeSha = out.sha;
      }
    }

    // ---- bookkeeping: repeatable, never touches GitHub again ----
    const audit = {
      ts: new Date(d.now()).toISOString(), action_id: a.action_id, kind: a.kind, repo: a.repo, pr: a.pr, head_sha: a.head_sha,
      approver: { type: "device", id: approval.device_id }, result: "merged", merge_sha: mergeSha,
    };
    await upstream(() => d.ops.addAudit(audit), "bookkeeping_failed");
    const t = await upstream(() => d.tasks(a.task), "bookkeeping_failed");
    if (t?.state !== "done") await upstream(() => d.ops.setDone(a.task), "bookkeeping_failed");
    const adv = await advance(d.ops, t?.parent, d.log);
    d.appendEvent("action.executed", { action_id: a.action_id, kind: a.kind, task: a.task, repo: a.repo, pr: a.pr, merge_sha: mergeSha, started: adv.started.length }, a.action_id);
    return { merge_sha: mergeSha };
  };
}
