import { verifySignature } from "../auth/keys.ts";
import { CanonicalError, parseChallengeBytes } from "../auth/canonical.ts";
import type { DeviceLedger, DeviceRecord } from "../auth/devices.ts";
import type { ErrorCode } from "../http/errors.ts";
import { buildChallenge, expiryOf, isExpired, newActionId, newNonce, type ChallengeFields } from "./challenge.ts";
import { ciState, type GithubReader, type PullFacts } from "./github.ts";
import { ActionStore, isTerminal, StateError, type ActionRecord, type ActionResult } from "./state.ts";

/** A refusal the HTTP layer renders as is: `status` + contract error `code` + machine readable `details`. */
export class ActionError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: ErrorCode, reason: string, details?: Record<string, unknown>) {
    super(reason);
    this.name = "ActionError";
    this.status = status;
    this.code = code;
    this.details = { reason, ...details };
  }
}

export type TaskInfo = { id: string; state: string; parent?: string | null; pr?: { number: number; repo: string; base: string } | null };
/** Task facts from the kb (`vlad task show`). Null when the task does not exist. */
export type TaskSource = (id: string) => Promise<TaskInfo | null>;

/** What was approved, derived by the server (never taken from a card). */
export type ActionDescriptor = { action_id: string; kind: string; repo: string; pr: number; base: string; head_sha: string; task: string };
/** Proof that a device approved exactly these challenge bytes. S10a adds `{ kind: "grant", ... }`. */
export type ApprovalProof = { kind: "device"; device_id: string; signature: string; signed_bytes_b64: string; approved_at_ms: number };
/**
 * The only way out of the approval path (S9b implements it: check-run, merge, audit). Throw an `ActionError` to report a
 * specific refusal (`head_moved`), anything else becomes a generic failure. In S9a nothing here writes to GitHub.
 */
export type ExecuteAction = (action: ActionDescriptor, approval: ApprovalProof) => Promise<ActionResult>;

export type ActionPolicy = {
  /** Accept `mergeable_state: blocked`. S9b needs it: until `vlad-gate` writes `vlad/approved` a protected branch reports `blocked`. */
  allowBlocked?: boolean;
};

export type ActionDeps = {
  store: ActionStore;
  devices: DeviceLedger;
  reader: GithubReader;
  tasks: TaskSource;
  execute: ExecuteAction;
  now: () => number;
  /** `mergeable: null` retries wait with this (default: real timer). */
  sleep?: (ms: number) => Promise<void>;
  policy?: ActionPolicy;
};

export const KINDS = ["merge_phase", "merge_final", "tag_release"] as const;
export type PrepareInput = { kind: string; task_id?: string; card_id?: string; params?: Record<string, string> };
export type Prepared = { action_id: string; bytes_b64: string; fields: ChallengeFields; exp: number };
export type Approved = { status: "executed"; result: { kind: string; repo: string; pr: number; head_sha: string; merge_sha?: string } };

export const MERGEABLE_ATTEMPTS = 3;
export const MERGEABLE_WAIT_MS = 2000;

const TASK_ID = /^T[0-9]{8}-[0-9]{2,}$/;

export class ActionService {
  private readonly d: ActionDeps;
  /** Latest server time seen. A reading below it means the clock moved back: every pending challenge dies. */
  private highWater = 0;

  constructor(deps: ActionDeps) {
    this.d = deps;
    deps.store.prune(deps.now(), 24 * 3600_000);
  }

  private sleep = (ms: number) => (this.d.sleep ? this.d.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)));

  /** Reads the clock once per operation and handles a rewind. */
  private tick(): number {
    const t = this.d.now();
    if (t < this.highWater) {
      for (const rec of this.d.store.list()) if (rec.state === "prepared" || rec.state === "approved") this.d.store.transition(rec.action_id, "invalid", t, { reason: "clock_rewind" });
    }
    this.highWater = Math.max(this.highWater, t);
    return t;
  }

  private load(id: string): ActionRecord {
    const rec = this.d.store.get(id);
    if (!rec) throw new ActionError(404, "bad_request", "not_found");
    return rec;
  }

  // ---- prepare -------------------------------------------------------------------------------------------------

  async prepare(device: DeviceRecord, input: PrepareInput): Promise<Prepared> {
    if (input.kind !== "merge_phase" && input.kind !== "merge_final") throw new ActionError(400, "bad_request", "kind_not_supported");
    if (input.params && Object.keys(input.params).length) throw new ActionError(400, "bad_request", "params_not_supported");
    const gate = input.card_id?.match(/^gate-(T[0-9]{8}-[0-9]{2,})$/);
    if (input.card_id && !gate) throw new ActionError(400, "bad_request", "card_not_gate");
    if (input.task_id && gate && input.task_id !== gate[1]) throw new ActionError(400, "bad_request", "task_card_mismatch");
    const taskId = input.task_id ?? gate?.[1];
    if (!taskId || !TASK_ID.test(taskId)) throw new ActionError(400, "bad_request", "task_required");

    return this.d.store.withLock(`prepare:${taskId}`, async () => {
      this.tick();
      // Everything comes from the task (what is waiting) and from GitHub (what is true now); a card contributes nothing.
      const task = await this.d.tasks(taskId);
      if (!task) throw new ActionError(404, "bad_request", "not_found");
      if (task.state !== "awaiting_approval") throw new ActionError(409, "bad_request", "task_not_awaiting_approval");
      if (!task.pr) throw new ActionError(409, "bad_request", "task_has_no_pr");
      const { repo, number: prNo, base: taskBase } = task.pr;
      if (input.kind === "merge_phase" ? !task.parent || taskBase !== `vlad/${task.parent}` : taskBase.startsWith("vlad/")) throw new ActionError(409, "not_mergeable", "kind_base_mismatch");

      const pull = await this.read(() => this.d.reader.getPull(repo, prNo));
      if (!pull) throw new ActionError(409, "not_mergeable", "pr_not_found");
      this.checkOpen(pull);
      if (pull.head.ref !== `vlad/${task.id}`) throw new ActionError(409, "not_mergeable", "head_ref_mismatch");
      if (pull.base.ref !== taskBase) throw new ActionError(409, "not_mergeable", "base_mismatch");
      await this.checkCi(repo, pull.head.sha);

      const id = newActionId();
      const nowMs = this.tick();
      const exp = expiryOf(nowMs);
      let c: ReturnType<typeof buildChallenge>;
      try {
        c = buildChallenge({ actionId: id, kind: input.kind, repo, pr: prNo, base: pull.base.ref, headSha: pull.head.sha, task: task.id, nonce: newNonce(), exp });
      } catch (e) {
        // A branch name or id that cannot be written as a challenge value (newline, `=`, off-alphabet byte) is refused, never escaped.
        if (e instanceof CanonicalError) throw new ActionError(409, "bad_request", "unrepresentable_field");
        throw e;
      }
      this.d.store.create({
        action_id: id, bytes_b64: Buffer.from(c.bytes).toString("base64"), fields: c.fields, task_id: task.id, ...(input.card_id ? { card_id: input.card_id } : {}),
        prepared_by: device.device_id, created_ms: nowMs, exp,
      });
      // The newest prepare for a task (or its card) is the only usable one.
      for (const old of this.d.store.list()) {
        if (old.action_id !== id && old.task_id === task.id && (old.state === "prepared" || old.state === "approved")) this.d.store.transition(old.action_id, "invalid", nowMs, { reason: "superseded" });
      }
      return { action_id: id, bytes_b64: Buffer.from(c.bytes).toString("base64"), fields: c.fields, exp };
    });
  }

  // ---- approve -------------------------------------------------------------------------------------------------

  /**
   * Steps 1-4 of the approval order that need no GitHub: device not revoked, challenge known/owned/alive/not used up, and the
   * `approval` signature over the STORED bytes. Used by the central approval guard (before any handler runs) and again
   * under the action lock by {@link approve}. Throws `ActionError`; returns the record.
   */
  admit(device: DeviceRecord, actionId: string, signature: string): ActionRecord {
    const nowMs = this.tick();
    const current = this.d.devices.get(device.device_id);
    if (!current || current.revoked_at) throw new ActionError(401, "device_revoked", "device_revoked");
    const rec = this.load(actionId);
    // Not "this device's" challenge looks exactly like an unknown one.
    if (rec.prepared_by !== current.device_id) throw new ActionError(404, "bad_request", "not_found");
    if (rec.state === "invalid") throw new ActionError(410, "expired", rec.reason ?? "invalid");
    if (rec.state === "failed") throw new ActionError(409, "bad_request", "action_failed", { cause: rec.reason ?? "unknown" });
    if (rec.state !== "merged") {
      if (nowMs < rec.created_ms) {
        this.d.store.transition(rec.action_id, "invalid", nowMs, { reason: "clock_rewind" });
        throw new ActionError(410, "expired", "clock_rewind");
      }
      if (isExpired(nowMs, rec.exp)) {
        if (!isTerminal(rec.state)) this.d.store.transition(rec.action_id, "invalid", nowMs, { reason: "expired" });
        throw new ActionError(410, "expired", "expired");
      }
    }
    // The stored bytes are what the user's key must have signed, and they must still be a well-formed challenge for this very record.
    const bytes = Buffer.from(rec.bytes_b64, "base64");
    let parsed: Record<string, string>;
    try {
      parsed = parseChallengeBytes(bytes);
    } catch {
      throw new ActionError(500, "bad_request", "stored_challenge_corrupt");
    }
    if (parsed.action_id !== rec.action_id) throw new ActionError(500, "bad_request", "stored_challenge_corrupt");
    if (!verifySignature(current.approval_pub, bytes, signature)) throw new ActionError(401, "unauthorized", "bad_approval_signature");
    return rec;
  }

  async approve(device: DeviceRecord, actionId: string, signature: string): Promise<Approved> {
    return this.d.store.withLock(actionId, async () => {
      const rec = this.admit(device, actionId, signature);
      const f = rec.fields;
      const out = (r: ActionResult): Approved => ({
        status: "executed",
        result: { kind: f.kind, repo: f.repo, pr: Number(f.pr), head_sha: f.head_sha, ...(r.merge_sha ? { merge_sha: r.merge_sha } : {}) },
      });
      if (rec.state === "merged") return out(rec.result ?? {});

      // prepared -> approved: the signature is on record. `approved`/`checked` here mean an earlier attempt did not finish; carry on from there.
      let cur = rec;
      if (cur.state === "prepared") cur = this.d.store.transition(cur.action_id, "approved", this.tick(), { approval: { device_id: device.device_id, signature, at_ms: this.d.now() } });

      await this.liveChecks(cur);

      cur = this.fresh(cur.action_id);
      if (cur.state === "approved") cur = this.d.store.transition(cur.action_id, "checked", this.tick());
      // Last look before the single exit: the device may have been revoked while GitHub was being read.
      cur = this.fresh(cur.action_id);
      if (this.d.devices.get(cur.prepared_by)?.revoked_at) {
        this.d.store.transition(cur.action_id, "invalid", this.tick(), { reason: "revoked" });
        throw new ActionError(410, "expired", "revoked");
      }
      const approval = cur.approval!;
      let result: ActionResult;
      try {
        result = await this.d.execute(
          { action_id: cur.action_id, kind: f.kind, repo: f.repo, pr: Number(f.pr), base: f.base, head_sha: f.head_sha, task: f.task },
          { kind: "device", device_id: approval.device_id, signature: approval.signature, signed_bytes_b64: cur.bytes_b64, approved_at_ms: approval.at_ms },
        );
      } catch (e) {
        const err = e instanceof ActionError ? e : new ActionError(502, "bad_request", "execute_failed");
        this.settle(cur.action_id, "failed", err.message);
        throw err;
      }
      this.d.store.transition(cur.action_id, "merged", this.tick(), { result });
      return out(result);
    });
  }

  /** Reloads a record after an `await`: revocation or a rewind may have invalidated it meanwhile. */
  private fresh(id: string): ActionRecord {
    const rec = this.load(id);
    if (rec.state === "invalid") throw new ActionError(410, "expired", rec.reason ?? "invalid");
    return rec;
  }

  private settle(id: string, to: "failed", reason: string) {
    const rec = this.d.store.get(id);
    if (rec && !isTerminal(rec.state)) this.d.store.transition(id, to, this.tick(), { reason });
  }

  /** A refusal that ends the action: recorded as `failed` (a new prepare is the way forward), then thrown. */
  private refuse(id: string, e: ActionError): never {
    this.settle(id, "failed", e.message);
    throw e;
  }

  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ActionError) throw e;
      // GitHub unreachable or answering something unknown: nothing was decided, the challenge stays usable until `exp`.
      throw new ActionError(503, "bad_request", "github_unavailable");
    }
  }

  private checkOpen(pull: PullFacts) {
    if (pull.merged) throw new ActionError(409, "not_mergeable", "pr_merged");
    if (pull.state !== "open") throw new ActionError(409, "not_mergeable", "pr_closed");
    if (pull.draft) throw new ActionError(409, "not_mergeable", "draft");
  }

  private async checkCi(repo: string, sha: string) {
    const [runs, status] = await this.read(() => Promise.all([this.d.reader.getCheckRuns(repo, sha), this.d.reader.getCombinedStatus(repo, sha)]));
    const ci = ciState(runs, status);
    if (ci !== "green") throw new ActionError(422, "ci_not_green", "ci_not_green", { ci });
  }

  /** Steps 5-8: PR open, head and base unchanged, CI green, mergeable. Every refusal here is final for this challenge. */
  private async liveChecks(rec: ActionRecord) {
    const f = rec.fields;
    const pr = Number(f.pr);
    try {
      let pull: PullFacts | null = null;
      for (let attempt = 1; attempt <= MERGEABLE_ATTEMPTS; attempt++) {
        pull = await this.read(() => this.d.reader.getPull(f.repo, pr));
        if (!pull) throw new ActionError(409, "not_mergeable", "pr_not_found");
        this.checkOpen(pull);
        if (pull.head.sha !== f.head_sha) throw new ActionError(409, "head_moved", "head_moved");
        if (pull.base.ref !== f.base) throw new ActionError(409, "not_mergeable", "base_changed");
        if (attempt === 1) await this.checkCi(f.repo, f.head_sha);
        if (pull.mergeable !== null && pull.mergeable_state !== "unknown") break;
        if (attempt < MERGEABLE_ATTEMPTS) await this.sleep(MERGEABLE_WAIT_MS);
      }
      if (pull!.mergeable === null || pull!.mergeable_state === "unknown") throw new ActionError(409, "not_mergeable", "mergeable_unknown");
      const s = pull!.mergeable_state;
      const okState = s === "clean" || s === "has_hooks" || (s === "blocked" && this.d.policy?.allowBlocked === true);
      if (!pull!.mergeable || !okState) throw new ActionError(409, "not_mergeable", s === "dirty" ? "conflict" : s === "blocked" ? "blocked" : s === "behind" ? "behind" : `state_${s}`);
    } catch (e) {
      // A 503 (GitHub unreachable) decides nothing; everything else ends this challenge.
      if (e instanceof ActionError && e.status !== 503) this.refuse(rec.action_id, e);
      throw e;
    }
  }

  // ---- revocation ----------------------------------------------------------------------------------------------

  /**
   * `AppConfig.onRevoke`: every pending challenge the device asked for dies. Synchronous, so nothing can interleave.
   * A `checked` action may already be inside the executor and is left alone; `approve` looks at the device once more right before the exit.
   */
  onDeviceRevoked(deviceId: string): void {
    const t = this.d.now();
    for (const rec of this.d.store.list()) {
      if (rec.prepared_by === deviceId && (rec.state === "prepared" || rec.state === "approved")) this.d.store.transition(rec.action_id, "invalid", t, { reason: "revoked" });
    }
  }
}

export { StateError };
