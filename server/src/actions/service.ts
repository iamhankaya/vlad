import { CanonicalError, parseChallengeBytes } from "../auth/canonical.ts";
import type { DeviceLedger, DeviceRecord } from "../auth/devices.ts";
import { verifySignature } from "../auth/keys.ts";
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

export type TaskInfo = { id: string; project: string; state: string; parent?: string | null; pr?: { number: number; repo: string; base: string } | null };
/** Task facts from the kb (`vlad task show`). Null when the task does not exist. */
export type TaskSource = (id: string) => Promise<TaskInfo | null>;
/** The project card's registered repo and default branch (`vlad project list`). Null when the project is unknown. */
export type ProjectInfo = { repo?: string; default_branch?: string };
export type ProjectSource = (slug: string) => Promise<ProjectInfo | null>;

/** What was approved, derived by the server (never taken from a card). */
export type ActionDescriptor = { action_id: string; kind: string; repo: string; pr: number; base: string; head_sha: string; task: string };
/** Proof that a device approved exactly these challenge bytes. S10a adds `{ kind: "grant", ... }`. */
export type ApprovalProof = { kind: "device"; device_id: string; signature: string; signed_bytes_b64: string; approved_at_ms: number };
/**
 * The only way out of the approval path (S9b implements it: check-run, merge, audit). Throw an `ActionError` to report a
 * specific refusal (`head_moved`), anything else becomes a generic failure. In S9a nothing here writes to GitHub.
 */
export type ExecuteAction = (action: ActionDescriptor, approval: ApprovalProof, ctx?: ExecuteContext) => Promise<ActionResult>;
/** `stillAuthorized()`: asked right before the write; false when the approving device was revoked or the task is no longer waiting for this. */
export type ExecuteContext = { stillAuthorized: () => Promise<boolean> };

export type ActionPolicy = {
  /** Accept `mergeable_state: blocked`. S9b needs it: until `vlad-gate` writes `vlad/approved` a protected branch reports `blocked`. */
  allowBlocked?: boolean;
  /** Minimum time between two prepares of one task by one device (each costs GitHub reads and a file). Default 5000. */
  prepareIntervalMs?: number;
  /** Wrong signatures one action tolerates before it refuses to look at more. Default 5. */
  maxBadSignatures?: number;
  /** The GitHub App's id: a `vlad/approved` run only counts as ours (and is left out of CI) when this app wrote it. */
  appId?: number;
};

export type ActionDeps = {
  store: ActionStore;
  devices: DeviceLedger;
  reader: GithubReader;
  tasks: TaskSource;
  projects: ProjectSource;
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
export const PRUNE_AFTER_MS = 24 * 3600_000;

/** Failures that decide nothing about the merge: the action stays `checked` and the same approval may be sent again. */
const RETRYABLE = new Set(["github_unavailable", "bookkeeping_failed"]);

const TASK_ID = /^T[0-9]{8}-[0-9]{2,}$/;

/**
 * Rules:
 * - State changes happen only inside `store.withLock(actionId)` (prepare also under a per-task lock). `inspect` and the
 *   approval guard never write.
 * - `exp` limits only `prepared -> approved`; once the signature is on record the action may be resumed after `exp`.
 */
export class ActionService {
  private readonly d: ActionDeps;
  /** Latest server time seen. A reading below it means the clock moved back: every pending challenge dies. */
  private highWater = 0;
  private readonly byTask = new Map<string, Set<string>>();
  private readonly lastPrepare = new Map<string, number>();
  private readonly badSigs = new Map<string, number>();
  private readonly background = new Set<Promise<unknown>>();

  constructor(deps: ActionDeps) {
    this.d = deps;
    for (const r of deps.store.list()) this.index(r.task_id, r.action_id);
    this.prune();
  }

  private sleep = (ms: number) => (this.d.sleep ? this.d.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)));
  private index(task: string, id: string) {
    (this.byTask.get(task) ?? this.byTask.set(task, new Set()).get(task)!).add(id);
  }

  /** Resolves when background work (revocation, clock-rewind sweeps) has finished. */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }
  private track(p: Promise<unknown>) {
    const q = p.catch(() => {}).finally(() => this.background.delete(q));
    this.background.add(q);
  }

  /** Drops old records and their index entries; called at start and periodically by the app. */
  prune(): number {
    const now = this.d.now();
    const n = this.d.store.prune(now, PRUNE_AFTER_MS);
    if (n) for (const [task, ids] of this.byTask) {
      for (const id of ids) if (!this.d.store.get(id)) ids.delete(id);
      if (!ids.size) this.byTask.delete(task);
    }
    for (const id of this.badSigs.keys()) if (!this.d.store.get(id)) this.badSigs.delete(id);
    for (const [k, t] of this.lastPrepare) if (now - t > PRUNE_AFTER_MS) this.lastPrepare.delete(k);
    return n;
  }

  private load(id: string): ActionRecord {
    const rec = this.d.store.get(id);
    if (!rec) throw new ActionError(404, "bad_request", "not_found");
    return rec;
  }

  private readonly maxBad = () => this.d.policy?.maxBadSignatures ?? 5;

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
      this.observeClock();
      // One prepare per device and task per interval: every one costs GitHub reads and a state file.
      const key = `${device.device_id}:${taskId}`;
      const interval = this.d.policy?.prepareIntervalMs ?? 5000;
      const last = this.lastPrepare.get(key);
      const t0 = this.d.now();
      if (last !== undefined && t0 >= last && t0 - last < interval) {
        throw new ActionError(429, "rate_limited", "prepare_too_soon", { retry_after_s: Math.max(1, Math.ceil((interval - (t0 - last)) / 1000)) });
      }
      this.lastPrepare.set(key, t0);

      // An action of this task that is past the check (`checked`, maybe already merged) must be finished by its own approval first:
      // a second challenge could merge or audit the same task twice.
      for (const oid of this.byTask.get(taskId) ?? []) {
        if (this.d.store.get(oid)?.state === "checked") throw new ActionError(409, "bad_request", "action_in_flight", { action_id: oid });
      }

      // Everything comes from the task, the project card (which repo/branch may be merged) and GitHub (what is true now).
      const { task, repo, prNo, base, kind } = await this.target(taskId);
      if (input.kind !== kind) throw new ActionError(409, "bad_request", "kind_mismatch", { expected: kind });

      const pull = await this.read(() => this.d.reader.getPull(repo, prNo));
      if (!pull) throw new ActionError(409, "not_mergeable", "pr_not_found");
      this.checkOpen(pull);
      this.checkOrigin(pull, repo, task.id, base);
      await this.checkCi(repo, pull.head.sha);

      const id = newActionId();
      const nowMs = this.d.now();
      this.highWater = Math.max(this.highWater, nowMs);
      const exp = expiryOf(nowMs);
      let c: ReturnType<typeof buildChallenge>;
      try {
        c = buildChallenge({ actionId: id, kind, repo, pr: prNo, base: pull.base.ref, headSha: pull.head.sha, task: task.id, nonce: newNonce(), exp });
      } catch (e) {
        // A branch name or id that cannot be written as a challenge value (newline, `=`, off-alphabet byte) is refused, never escaped.
        if (e instanceof CanonicalError) throw new ActionError(409, "bad_request", "unrepresentable_field");
        throw e;
      }
      const bytes_b64 = Buffer.from(c.bytes).toString("base64");
      await this.d.store.withLock(id, () => {
        this.d.store.create({
          action_id: id, bytes_b64, fields: c.fields, task_id: task.id, ...(input.card_id ? { card_id: input.card_id } : {}),
          prepared_by: device.device_id, created_ms: nowMs, exp,
        });
        this.index(task.id, id);
      });
      // This device's newest prepare for the task is its only usable one (another device's challenges are not touched).
      for (const oldId of [...(this.byTask.get(task.id) ?? [])]) {
        if (oldId === id) continue;
        await this.d.store.withLock(oldId, () => {
          const old = this.d.store.get(oldId);
          if (old && old.prepared_by === device.device_id && (old.state === "prepared" || old.state === "approved")) this.d.store.transition(oldId, "invalid", nowMs, { reason: "superseded" });
        });
      }
      return { action_id: id, bytes_b64, fields: c.fields, exp };
    });
  }

  /**
   * What the task asks to be merged, checked against the project card: the repo must be the card's registered repo, and
   * the kind follows from the task (a phase of a pipeline goes into `vlad/<parent>`, a root/single task into the card's default
   * branch), never from the client.
   */
  private async target(taskId: string) {
    const task = await this.read(() => this.d.tasks(taskId));
    if (!task) throw new ActionError(404, "bad_request", "not_found");
    if (task.state !== "awaiting_approval") throw new ActionError(409, "bad_request", "task_not_awaiting_approval");
    if (!task.pr) throw new ActionError(409, "bad_request", "task_has_no_pr");
    const card = await this.read(() => this.d.projects(task.project));
    if (!card?.repo) throw new ActionError(409, "bad_request", "project_has_no_repo");
    if (task.pr.repo !== card.repo) throw new ActionError(409, "not_mergeable", "repo_not_registered");
    const { kind, base: expectedBase } = this.derive(task, card);
    if (task.pr.base !== expectedBase) throw new ActionError(409, "not_mergeable", "kind_base_mismatch");
    return { task, repo: card.repo, prNo: task.pr.number, base: expectedBase, kind };
  }

  /** The kind and base a task's merge must have: a phase goes into `vlad/<parent>`, a root/single task into the card's default branch. Used at prepare and again at approve. */
  private derive(task: TaskInfo, card: ProjectInfo) {
    return { kind: task.parent ? "merge_phase" : "merge_final", base: task.parent ? `vlad/${task.parent}` : (card.default_branch ?? "master") };
  }

  private checkOrigin(pull: PullFacts, repo: string, taskId: string, base: string) {
    if (pull.head.repo !== repo || pull.base.repo !== repo) throw new ActionError(409, "not_mergeable", "fork_or_foreign_repo");
    if (pull.head.ref !== `vlad/${taskId}`) throw new ActionError(409, "not_mergeable", "head_ref_mismatch");
    if (pull.base.ref !== base) throw new ActionError(409, "not_mergeable", "base_mismatch");
  }

  // ---- approve -------------------------------------------------------------------------------------------------

  /**
   * Steps 1-4 of the approval order that need no GitHub, WITHOUT writing anything: device not revoked, challenge known/owned,
   * not dead, not rewound, not expired (only before it was approved), and the `approval` signature over the STORED bytes.
   * The approval guard runs it before any handler; {@link approve} runs it again under the action lock.
   * A dead challenge is reported as 410; the transition to `invalid` is queued under the action lock, never done here.
   */
  inspect(device: DeviceRecord, actionId: string, signature: string): ActionRecord {
    const nowMs = this.d.now();
    const current = this.d.devices.get(device.device_id);
    if (!current || current.revoked_at) throw new ActionError(401, "device_revoked", "device_revoked");
    const rec = this.load(actionId);
    // Not "this device's" challenge looks exactly like an unknown one.
    if (rec.prepared_by !== current.device_id) throw new ActionError(404, "bad_request", "not_found");
    if (rec.state === "invalid") throw new ActionError(410, "expired", rec.reason ?? "invalid");
    if (rec.state === "failed") throw new ActionError(409, "bad_request", "action_failed", { cause: rec.reason ?? "unknown" });
    if (rec.state !== "merged") {
      if (nowMs < this.highWater || nowMs < rec.created_ms) {
        this.sweepAfterRewind();
        throw new ActionError(410, "expired", "clock_rewind");
      }
      if (rec.state === "prepared" && isExpired(nowMs, rec.exp)) {
        this.invalidateLater(rec.action_id, "expired");
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
    if (parsed.action_id !== rec.action_id || Object.keys(parsed).some((k) => parsed[k] !== (rec.fields as Record<string, string>)[k])) throw new ActionError(500, "bad_request", "stored_challenge_corrupt");
    const bad = this.badSigs.get(rec.action_id) ?? 0;
    if (bad >= this.maxBad()) throw new ActionError(429, "rate_limited", "too_many_bad_signatures");
    if (!verifySignature(current.approval_pub, bytes, signature)) {
      this.badSigs.set(rec.action_id, bad + 1);
      throw new ActionError(401, "unauthorized", "bad_approval_signature");
    }
    return rec;
  }

  async approve(device: DeviceRecord, actionId: string, signature: string): Promise<Approved> {
    return this.d.store.withLock(actionId, async () => {
      const rec = this.inspect(device, actionId, signature);
      const f = parseChallengeBytes(Buffer.from(rec.bytes_b64, "base64")); // what the user's key signed, not what the record says
      const out = (r: ActionResult): Approved => ({
        status: "executed",
        result: { kind: f.kind!, repo: f.repo!, pr: Number(f.pr), head_sha: f.head_sha!, ...(r.merge_sha ? { merge_sha: r.merge_sha } : {}) },
      });
      if (rec.state === "merged") return out(rec.result ?? {});

      // prepared -> approved: the signature is on record. `approved`/`checked` here mean an earlier attempt did not finish; carry on from there.
      let cur = rec;
      if (cur.state === "prepared") cur = this.d.store.transition(cur.action_id, "approved", this.d.now(), { approval: { device_id: device.device_id, signature, at_ms: this.d.now() } });

      await this.liveChecks(cur, f, rec.state === "checked");

      cur = this.fresh(cur.action_id);
      if (cur.state === "approved") cur = this.d.store.transition(cur.action_id, "checked", this.d.now());
      // Last look before the single exit: the device may have been revoked while GitHub was being read.
      cur = this.fresh(cur.action_id);
      if (this.d.devices.get(cur.prepared_by)?.revoked_at) {
        this.d.store.transition(cur.action_id, "invalid", this.d.now(), { reason: "revoked" });
        throw new ActionError(410, "expired", "revoked");
      }
      const approval = cur.approval!;
      let result: ActionResult;
      try {
        result = await this.d.execute(
          { action_id: cur.action_id, kind: f.kind!, repo: f.repo!, pr: Number(f.pr), base: f.base!, head_sha: f.head_sha!, task: f.task! },
          { kind: "device", device_id: approval.device_id, signature: approval.signature, signed_bytes_b64: cur.bytes_b64, approved_at_ms: approval.at_ms },
          { stillAuthorized: () => this.stillAuthorized(cur.action_id, f) },
        );
      } catch (e) {
        const err = e instanceof ActionError ? e : new ActionError(502, "bad_request", "execute_failed");
        // GitHub or the kb not reachable (or bookkeeping after a merge failed): the action stays `checked`, the same signature may retry.
        if (!(RETRYABLE.has(String(err.details?.reason)))) this.settle(cur.action_id, "failed", err.message);
        throw err;
      }
      this.d.store.transition(cur.action_id, "merged", this.d.now(), { result });
      return out(result);
    });
  }

  /**
   * Asked by the executor right before it writes to GitHub: the approving device must still be active, the challenge not
   * dead, and the task still waiting for exactly this merge. A revocation ends the action (`invalid`), a changed task fails it.
   * Fails closed: if the task cannot be read, nothing is written.
   */
  private async stillAuthorized(id: string, f: Record<string, string>): Promise<boolean> {
    const rec = this.d.store.get(id);
    if (!rec || rec.state === "invalid" || isTerminal(rec.state)) throw new ActionError(410, "expired", rec?.reason ?? "invalid");
    if (this.d.devices.get(rec.prepared_by)?.revoked_at) {
      this.d.store.transition(id, "invalid", this.d.now(), { reason: "revoked" });
      throw new ActionError(410, "expired", "revoked");
    }
    let t: TaskInfo | null;
    try {
      t = await this.d.tasks(f.task!);
    } catch {
      throw new ActionError(503, "bad_request", "github_unavailable");
    }
    if (!t || t.state !== "awaiting_approval" || !t.pr || t.pr.repo !== f.repo || t.pr.number !== Number(f.pr) || t.pr.base !== f.base) throw new ActionError(409, "bad_request", "task_changed");
    return true;
  }

  /** Reloads a record after an `await`: revocation or a rewind may have invalidated it meanwhile. */
  private fresh(id: string): ActionRecord {
    const rec = this.load(id);
    if (rec.state === "invalid") throw new ActionError(410, "expired", rec.reason ?? "invalid");
    return rec;
  }

  private settle(id: string, to: "failed", reason: string) {
    const rec = this.d.store.get(id);
    if (rec && !isTerminal(rec.state)) this.d.store.transition(id, to, this.d.now(), { reason });
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
      // GitHub or the kb unreachable, or answering something unknown: nothing was decided, the challenge stays usable.
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
    const ci = ciState(runs, status, this.d.policy?.appId);
    if (ci !== "green") throw new ActionError(422, "ci_not_green", "ci_not_green", { ci });
  }

  /** Steps 5-8: PR open, head and base unchanged, CI green, mergeable. Every refusal here is final for this challenge. */
  private async liveChecks(rec: ActionRecord, f: Record<string, string>, resuming: boolean) {
    const pr = Number(f.pr);
    try {
      // An earlier attempt may have merged and died before the bookkeeping (task `done`, audit): if the PR is merged at exactly the
      // approved head, there is nothing to re-check; the executor completes the rest without a second merge.
      if (resuming) {
        const p = await this.read(() => this.d.reader.getPull(f.repo!, pr));
        if (p?.merged) {
          // Still the task this challenge was for (waiting, or already `done` by an earlier attempt) in the registered repo.
          const t0 = await this.read(() => this.d.tasks(f.task!));
          if (!t0 || (t0.state !== "awaiting_approval" && t0.state !== "done") || !t0.pr || t0.pr.repo !== f.repo || t0.pr.number !== pr) throw new ActionError(409, "bad_request", "task_changed");
          const card0 = await this.read(() => this.d.projects(t0.project));
          if (card0?.repo !== f.repo) throw new ActionError(409, "not_mergeable", "repo_not_registered");
          this.checkOrigin(p, f.repo!, f.task!, f.base!);
          if (p.head.sha !== f.head_sha) throw new ActionError(409, "head_moved", "head_moved");
          return;
        }
      }
      // The task must still be waiting for exactly this: same repo, PR and base (it could have been re-pointed since prepare).
      const t = await this.read(() => this.d.tasks(f.task!));
      if (!t || t.state !== "awaiting_approval" || !t.pr || t.pr.repo !== f.repo || t.pr.number !== pr || t.pr.base !== f.base) throw new ActionError(409, "bad_request", "task_changed");
      const card = await this.read(() => this.d.projects(t.project));
      if (card?.repo !== f.repo) throw new ActionError(409, "not_mergeable", "repo_not_registered");
      // Kind and base follow from the task and the card as they are NOW (a changed default branch or parent kills the challenge).
      const want = this.derive(t, card);
      if (want.kind !== f.kind || want.base !== f.base) throw new ActionError(409, "not_mergeable", "base_mismatch");

      let pull: PullFacts | null = null;
      for (let attempt = 1; attempt <= MERGEABLE_ATTEMPTS; attempt++) {
        pull = await this.read(() => this.d.reader.getPull(f.repo!, pr));
        if (!pull) throw new ActionError(409, "not_mergeable", "pr_not_found");
        this.checkOpen(pull);
        if (pull.head.sha !== f.head_sha) throw new ActionError(409, "head_moved", "head_moved");
        this.checkOrigin(pull, f.repo!, f.task!, f.base!);
        if (attempt === 1) await this.checkCi(f.repo!, f.head_sha!);
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

  // ---- revocation and clock -----------------------------------------------------------------------------------

  /**
   * `AppConfig.onRevoke`: every pending challenge the device asked for dies, each under its own lock (an approval that is
   * mid-flight finishes first and looks at the device once more right before the exit). `checked` is left to that last look.
   * Use {@link settled} to wait for it.
   */
  onDeviceRevoked(deviceId: string): void {
    for (const rec of this.d.store.list()) {
      if (rec.prepared_by !== deviceId) continue;
      this.track(this.d.store.withLock(rec.action_id, () => {
        const r = this.d.store.get(rec.action_id);
        if (r && (r.state === "prepared" || r.state === "approved")) this.d.store.transition(r.action_id, "invalid", this.d.now(), { reason: "revoked" });
      }));
    }
  }

  private invalidateLater(id: string, reason: string) {
    this.track(this.d.store.withLock(id, () => {
      const r = this.d.store.get(id);
      if (r?.state === "prepared") this.d.store.transition(id, "invalid", this.d.now(), { reason });
    }));
  }

  private rewoundAt: number | null = null;

  /** Notes a clock that went back (reads stay blocked by `highWater`); the sweep below kills the pending challenges for good. */
  private observeClock() {
    if (this.d.now() < this.highWater) this.sweepAfterRewind();
    else this.highWater = this.d.now();
  }

  /** Kills every pending challenge under its lock, and only then lets `highWater` follow the clock again (no revival window). */
  private sweepAfterRewind() {
    if (this.rewoundAt !== null) return;
    this.rewoundAt = this.d.now();
    this.track((async () => {
      try {
        for (const rec of this.d.store.list()) {
          await this.d.store.withLock(rec.action_id, () => {
            const r = this.d.store.get(rec.action_id);
            if (r && (r.state === "prepared" || r.state === "approved")) this.d.store.transition(r.action_id, "invalid", this.d.now(), { reason: "clock_rewind" });
          });
        }
        this.highWater = this.d.now();
      } finally {
        this.rewoundAt = null;
      }
    })());
  }
}

export { StateError };
