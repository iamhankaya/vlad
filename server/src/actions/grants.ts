import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DeviceLedger, DeviceRecord } from "../auth/devices.ts";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../auth/files.ts";
import { decodeB64url, verifySignature } from "../auth/keys.ts";
import { runVlad, runVladJson } from "../vlad/cli.ts";
import { ActionError, gateKindOf, type ActionService, type Approved, type GrantPick, type ProjectSource, type TaskInfo, type TaskSource } from "./service.ts";

export const GRANT_ACTIONS = ["merge_phase", "merge_final"] as const;
/** Never delegable. The contract enum leaves them out and this list refuses them in code, separately (a request, a stored record, a task kind). */
export const NON_DELEGABLE_ACTIONS = ["tag_release", "publish", "delete", "security", "scope_change"] as const;
export const GRANT_CONDITIONS = ["ci_green", "no_severe_findings", "codex_clear"] as const;
export const GRANT_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/** `created` of a new grant may differ from the server clock by this much: an old signed request cannot be replayed into a fresh grant. */
export const CREATED_WINDOW_MS = 5 * 60 * 1000;
/** Grants kept in the books (revoked ones included): a device that went wild cannot grow the state file without bound. */
export const MAX_GRANTS = 200;

/** A grant as the phone signed it, plus the device that signed (the one from the verified envelope, never from the body). */
export type GrantRecord = {
  id: string;
  scope: { type: "project" | "pipeline"; ref: string };
  action: string;
  conditions: string[];
  created: string;
  expires: string;
  max_uses: number;
  signature: string;
  payload_version: "v1";
  device_id: string;
};
export type GrantEntry = { rec: GrantRecord; revoked_at?: string; /** Action ids that took a use. */ uses: string[] };
export type GrantStatus = "active" | "expired" | "revoked" | "device_revoked" | "exhausted";

/**
 * The exact string a device signs (`vlad-grant/v1\nid=..\n...`, no trailing newline; vector: `signing-vectors.json` `grant`). `conditions` are
 * sorted so the same grant always signs the same bytes. `device_id`, `revoked` and `payload_version` are not signed (the device comes from the envelope).
 */
export function grantSigningPayload(g: Pick<GrantRecord, "id" | "scope" | "action" | "conditions" | "created" | "expires" | "max_uses">): string {
  return [
    "vlad-grant/v1",
    `id=${g.id}`,
    `scope=${g.scope.type}:${g.scope.ref}`,
    `action=${g.action}`,
    `conditions=${[...g.conditions].sort().join(",")}`,
    `created=${g.created}`,
    `expires=${g.expires}`,
    `max_uses=${g.max_uses}`,
  ].join("\n");
}

const sigHash = (sig: string) => createHash("sha256").update(sig).digest("hex");

// ---- request parsing ------------------------------------------------------------------------------------------------

export class GrantRefusal extends Error {
  readonly status: number;
  readonly code: "bad_request" | "not_delegable" | "grant_invalid" | "device_revoked";
  readonly details: Record<string, unknown>;
  constructor(status: number, code: GrantRefusal["code"], reason: string, field?: string) {
    super(reason);
    this.status = status;
    this.code = code;
    this.details = { reason, ...(field ? { field } : {}) };
  }
}

const KEYS = ["id", "scope", "action", "conditions", "created", "expires", "max_uses", "signature", "payload_version"];
const ID = /^G-([0-9]{3}|[1-9][0-9]{3,})$/;
const REF = /^[A-Za-z0-9._-]{1,200}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseTs(v: unknown, field: string): number {
  if (typeof v !== "string" || !TS.test(v)) throw new GrantRefusal(400, "bad_request", "bad_field", field);
  const ms = Date.parse(v);
  // `2026-02-31T..` parses to March in some engines: the round trip must give the same instant.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== v.slice(0, 19)) throw new GrantRefusal(400, "bad_request", "bad_field", field);
  return ms;
}

/**
 * Body of `POST /grants` -> a grant without its device. Order: shape, then the action (not delegable is answered before anything else is
 * looked at, and independent of the schema's enum), then the rest, then the times against the server clock. The signature is the caller's next step.
 */
export function parseGrantRequest(raw: unknown, nowMs: number): Omit<GrantRecord, "device_id"> {
  if (!isObj(raw) || Object.keys(raw).some((k) => !KEYS.includes(k)) || KEYS.some((k) => !Object.hasOwn(raw, k))) throw new GrantRefusal(400, "bad_request", "bad_body");
  const action = raw.action;
  if (typeof action !== "string") throw new GrantRefusal(400, "bad_request", "bad_field", "action");
  if ((NON_DELEGABLE_ACTIONS as readonly string[]).includes(action)) throw new GrantRefusal(422, "not_delegable", "not_delegable", "action");
  if (!(GRANT_ACTIONS as readonly string[]).includes(action)) throw new GrantRefusal(400, "bad_request", "bad_field", "action");
  if (typeof raw.id !== "string" || !ID.test(raw.id)) throw new GrantRefusal(400, "bad_request", "bad_field", "id");
  const s = raw.scope;
  if (!isObj(s) || Object.keys(s).length !== 2 || (s.type !== "project" && s.type !== "pipeline") || typeof s.ref !== "string" || !REF.test(s.ref)) throw new GrantRefusal(400, "bad_request", "bad_field", "scope");
  const c = raw.conditions;
  if (!Array.isArray(c) || c.length > GRANT_CONDITIONS.length || c.some((x) => typeof x !== "string" || !(GRANT_CONDITIONS as readonly string[]).includes(x)) || new Set(c).size !== c.length || !c.includes("ci_green")) {
    throw new GrantRefusal(400, "bad_request", "bad_field", "conditions");
  }
  const created = parseTs(raw.created, "created");
  const expires = parseTs(raw.expires, "expires");
  if (!Number.isSafeInteger(raw.max_uses) || (raw.max_uses as number) < 1 || (raw.max_uses as number) > 1000) throw new GrantRefusal(400, "bad_request", "bad_field", "max_uses");
  if (raw.payload_version !== "v1") throw new GrantRefusal(400, "bad_request", "bad_field", "payload_version");
  if (!decodeB64url(raw.signature, 100)) throw new GrantRefusal(400, "bad_request", "bad_field", "signature");

  if (!(expires > created)) throw new GrantRefusal(422, "grant_invalid", "expires_before_created");
  if (expires - created > GRANT_MAX_MS) throw new GrantRefusal(422, "grant_invalid", "longer_than_30_days");
  if (Math.abs(created - nowMs) > CREATED_WINDOW_MS) throw new GrantRefusal(422, "grant_invalid", "created_out_of_window");
  if (expires <= nowMs) throw new GrantRefusal(422, "grant_invalid", "already_expired");
  return {
    id: raw.id, scope: { type: s.type, ref: s.ref }, action, conditions: c as string[], created: raw.created as string, expires: raw.expires as string,
    max_uses: raw.max_uses as number, signature: raw.signature as string, payload_version: "v1",
  };
}

/** The signature over the signing payload, with the `approval` key of the device that is named (a session key never verifies). */
export const signatureHolds = (rec: Omit<GrantRecord, "device_id"> | GrantRecord, device: DeviceRecord | undefined): boolean =>
  !!device && verifySignature(device.approval_pub, Buffer.from(grantSigningPayload(rec), "utf8"), rec.signature);

// ---- the books --------------------------------------------------------------------------------------------------------

/**
 * `grants.json` (the signed grants, revocations) and `grant-uses.json` (which action took which use) in the state directory. These
 * are the books; `kb/grants/` is a mirror anyone with kb access can edit and counts for nothing. Every change is one synchronous
 * check-and-write, so within the single API process two callers cannot both pass the same test (last use, revoke vs. use).
 */
export class GrantStore {
  private readonly grantsFile: string;
  private readonly usesFile: string;
  private readonly byId = new Map<string, GrantEntry>();

  constructor(stateDir: string) {
    ensureDir(stateDir);
    this.grantsFile = join(stateDir, "grants.json");
    this.usesFile = join(stateDir, "grant-uses.json");
    const uses = readJsonFile<{ uses: Record<string, string[]> }>(this.usesFile)?.uses ?? {};
    for (const g of readJsonFile<{ grants: { rec: GrantRecord; revoked_at?: string }[] }>(this.grantsFile)?.grants ?? []) {
      this.byId.set(g.rec.id, { rec: g.rec, ...(g.revoked_at ? { revoked_at: g.revoked_at } : {}), uses: [...(uses[g.rec.id] ?? [])] });
    }
  }

  get(id: string): GrantEntry | undefined {
    return this.byId.get(id);
  }
  /** In id order. */
  entries(): GrantEntry[] {
    return [...this.byId.values()].sort((a, b) => a.rec.id.localeCompare(b.rec.id, "en", { numeric: true }));
  }
  has(id: string, signature: string): boolean {
    return this.byId.has(id) || [...this.byId.values()].some((g) => sigHash(g.rec.signature) === sigHash(signature));
  }
  get size(): number {
    return this.byId.size;
  }

  add(rec: GrantRecord): void {
    this.byId.set(rec.id, { rec, uses: [] });
    this.saveGrants();
  }

  /** Permanent: a revoked grant is never active again (the entry stays, so its id and signature cannot be added anew). Idempotent; undefined = unknown id. */
  revoke(id: string, atIso: string): GrantEntry | undefined {
    const g = this.byId.get(id);
    if (!g) return undefined;
    if (!g.revoked_at) {
      g.revoked_at = atIso;
      this.saveGrants();
    }
    return g;
  }

  /** Takes one use for `actionId`. False when the grant is unknown, revoked or has none left; the same action asking again keeps its use (idempotent). */
  reserve(id: string, actionId: string): boolean {
    const g = this.byId.get(id);
    if (!g || g.revoked_at) return false;
    if (g.uses.includes(actionId)) return true;
    if (g.uses.length >= g.rec.max_uses) return false;
    g.uses.push(actionId);
    this.saveUses();
    return true;
  }

  release(id: string, actionId: string): void {
    const g = this.byId.get(id);
    if (!g || !g.uses.includes(actionId)) return;
    g.uses = g.uses.filter((a) => a !== actionId);
    this.saveUses();
  }

  private saveGrants() {
    writeJsonAtomic(this.grantsFile, { v: 1, grants: this.entries().map((g) => ({ rec: g.rec, ...(g.revoked_at ? { revoked_at: g.revoked_at } : {}) })) });
  }
  private saveUses() {
    writeJsonAtomic(this.usesFile, { v: 1, uses: Object.fromEntries(this.entries().filter((g) => g.uses.length).map((g) => [g.rec.id, g.uses])) });
  }
}

// ---- evaluation -------------------------------------------------------------------------------------------------------

/** What is true right now. Everything the books cannot know comes through here. */
export type LiveChecks = {
  device: (id: string) => DeviceRecord | undefined;
  /** CI of the head being merged is green (callers that checked it themselves answer true). */
  ci: () => Promise<boolean>;
  /** No open/deferred critical or high Claude finding in the project. A failure to find out is "no". */
  findingsClear: (project: string) => Promise<boolean>;
  /** Codex found nothing. There is no Codex here: unavailable is NOT clear (the card path stays open). */
  codexClear: (task: TaskInfo) => Promise<boolean>;
  /** Grants revoked through the kb: reduces only. */
  kbRevoked: ReadonlySet<string>;
};

export const scopeMatches = (scope: GrantRecord["scope"], task: Pick<TaskInfo, "id" | "project" | "parent">): boolean =>
  scope.type === "project" ? task.project === scope.ref : (task.parent ?? task.id) === scope.ref;

/** Why `g` does not cover this task now (a stable key), or null. `forSelection` also refuses a grant whose uses are all taken. */
export async function grantProblem(g: GrantEntry, task: TaskInfo, kind: string, live: LiveChecks, nowMs: number, forSelection: boolean): Promise<string | null> {
  const r = g.rec;
  if ((NON_DELEGABLE_ACTIONS as readonly string[]).includes(r.action) || !(GRANT_ACTIONS as readonly string[]).includes(r.action)) return "not_delegable";
  if (r.action !== kind) return "action_mismatch";
  if (g.revoked_at || live.kbRevoked.has(r.id)) return "grant_revoked";
  const created = Date.parse(r.created);
  const expires = Date.parse(r.expires);
  if (!(expires > created) || expires - created > GRANT_MAX_MS) return "grant_invalid";
  if (nowMs < created - CREATED_WINDOW_MS) return "grant_not_started";
  if (nowMs >= expires) return "grant_expired";
  const dev = live.device(r.device_id);
  if (!dev || dev.revoked_at) return "device_revoked";
  if (!signatureHolds(r, dev)) return "grant_invalid";
  if (!scopeMatches(r.scope, task)) return "scope_mismatch";
  if (forSelection && g.uses.length >= r.max_uses) return "max_uses";
  for (const c of r.conditions) {
    if (c === "ci_green" && !(await live.ci())) return "condition_ci_green";
    if (c === "no_severe_findings" && !(await live.findingsClear(task.project))) return "condition_no_severe_findings";
    if (c === "codex_clear" && !(await live.codexClear(task))) return "condition_codex_clear";
    if (!(GRANT_CONDITIONS as readonly string[]).includes(c)) return "grant_invalid";
  }
  return null;
}

/** The first grant (in id order) that covers `task`'s gate card now, or null: the card then waits for a person. Never throws for a grant that does not apply. */
export async function evaluateGrants(task: TaskInfo, grants: GrantEntry[], live: LiveChecks, nowMs: number): Promise<GrantEntry | null> {
  const kind = task.parent ? "merge_phase" : "merge_final";
  for (const g of grants) {
    try {
      if ((await grantProblem(g, task, kind, live, nowMs, true)) === null) return g;
    } catch {
      // a check that cannot be answered is a "no" for this grant
    }
  }
  return null;
}

// ---- kb mirror and defaults -------------------------------------------------------------------------------------------

/** The kb side, all through the `vlad` CLI. Its content is never trusted as a grant; it only mirrors the books and may revoke. */
export interface GrantKb {
  add(rec: GrantRecord): Promise<void>;
  /** `revoked` as the kb says. */
  list(): Promise<{ grants: { id: string; revoked: boolean }[]; warnings: string[] }>;
  revoke(id: string): Promise<void>;
}

export const vladGrantKb: GrantKb = {
  async add(rec) {
    await runVlad(["grant", "add", "--file", "-"], { input: JSON.stringify({ ...rec, revoked: false }) });
  },
  async list() {
    const r = await runVladJson<{ grants: { id: string; revoked?: boolean }[]; warnings?: string[] }>(["grant", "list"]);
    return { grants: r.grants.map((g) => ({ id: g.id, revoked: g.revoked === true })), warnings: r.warnings ?? [] };
  },
  async revoke(id) {
    if (!ID.test(id)) throw new Error("geçersiz devir id'si");
    await runVlad(["grant", "revoke", id]);
  },
};

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const vladFindingsClear = async (project: string): Promise<boolean> => {
  if (!SLUG.test(project)) return false;
  const r = await runVladJson<{ findings: unknown[] }>(["finding", "list", `--project=${project}`, "--state=open,deferred", "--severity=kritik,yüksek"]);
  return r.findings.length === 0;
};
const vladAwaiting = async (): Promise<string[]> => {
  const r = await runVladJson<{ tasks: { id: string; state: string }[] }>(["task", "list"]);
  return r.tasks.filter((t) => t.state === "awaiting_approval").map((t) => t.id);
};

export type GrantConfig = {
  kb?: GrantKb;
  findingsClear?: LiveChecks["findingsClear"];
  codexClear?: LiveChecks["codexClear"];
  /** Tasks waiting for approval (sweep). */
  listAwaiting?: () => Promise<string[]>;
  /** Sweep interval; unset/0 = no timer (the app's main sets it; a sweep also runs once at start). */
  sweepMs?: number;
  log?: (msg: string) => void;
};

export type GrantEngineDeps = {
  store: GrantStore;
  devices: DeviceLedger;
  svc: ActionService;
  tasks: TaskSource;
  projects: ProjectSource;
  now: () => number;
  config?: GrantConfig;
};

/**
 * Grants in motion: creating (device signed), revoking, and carrying out a gate that a grant covers. The merge itself is
 * `ActionService.executeGranted`, i.e. the approval path's single exit (check-run, `PUT merge` with `sha=head_sha`, origin checks,
 * `stillAuthorized`); a grant only replaces the signature over the challenge. Grants are looked at again before every outward write.
 */
export class GrantEngine {
  readonly store: GrantStore;
  private readonly d: GrantEngineDeps;
  readonly kb: GrantKb;
  private readonly findings: LiveChecks["findingsClear"];
  private readonly codex: LiveChecks["codexClear"];
  private creating: Promise<unknown> = Promise.resolve();
  private readonly background = new Set<Promise<unknown>>();
  private sweeping = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(d: GrantEngineDeps) {
    this.d = d;
    this.store = d.store;
    this.kb = d.config?.kb ?? vladGrantKb;
    this.findings = d.config?.findingsClear ?? vladFindingsClear;
    this.codex = d.config?.codexClear ?? (async () => false);
  }

  private log = (m: string) => this.d.config?.log?.(m);

  // ---- create / revoke / list

  /** Stores a grant whose signature the guard has verified. One at a time: the id check and the write are one critical section. */
  create(deviceId: string, g: Omit<GrantRecord, "device_id">): Promise<{ id: string }> {
    const run = this.creating.then(async () => {
      const dev = this.d.devices.get(deviceId);
      if (!dev || dev.revoked_at) throw new GrantRefusal(401, "device_revoked", "device_revoked");
      // Signature checked here again: the books never hold a grant that does not verify against its device's approval key.
      if (!signatureHolds(g, dev)) throw new GrantRefusal(422, "grant_invalid", "bad_signature");
      if (this.store.has(g.id, g.signature)) throw new GrantRefusal(409, "bad_request", this.store.get(g.id) ? "id_taken" : "signature_reused");
      if (this.store.size >= MAX_GRANTS) throw new GrantRefusal(409, "bad_request", "too_many_grants");
      const rec: GrantRecord = { ...g, device_id: deviceId };
      try {
        await this.kb.add(rec);
      } catch (e) {
        this.log(`grant add (kb): ${(e as Error).message}`);
        throw new GrantRefusal(503, "bad_request", "kb_unavailable");
      }
      this.store.add(rec);
      return { id: rec.id };
    });
    this.creating = run.catch(() => {});
    return run;
  }

  /** Permanent and immediate (the books); the kb mirror follows best effort. Returns false for an unknown id. */
  async revoke(id: string): Promise<boolean> {
    if (!this.store.revoke(id, new Date(this.d.now()).toISOString())) return false;
    try {
      await this.kb.revoke(id);
    } catch (e) {
      this.log(`grant revoke (kb): ${(e as Error).message}`);
    }
    return true;
  }

  statusOf(g: GrantEntry, kbRevoked: ReadonlySet<string> = new Set()): GrantStatus {
    const now = this.d.now();
    if (g.revoked_at || kbRevoked.has(g.rec.id)) return "revoked";
    const dev = this.d.devices.get(g.rec.device_id);
    if (!dev || dev.revoked_at) return "device_revoked";
    if (now >= Date.parse(g.rec.expires)) return "expired";
    if (g.uses.length >= g.rec.max_uses) return "exhausted";
    return "active";
  }

  async list() {
    const warnings: string[] = [];
    let kbRevoked = new Set<string>();
    try {
      const k = await this.kb.list();
      kbRevoked = new Set(k.grants.filter((x) => x.revoked).map((x) => x.id));
      warnings.push(...k.warnings);
      for (const x of k.grants) if (!this.store.get(x.id)) warnings.push(`kb'de kayıtsız devir yok sayıldı: ${x.id}`);
    } catch {
      warnings.push("kb devir listesi okunamadı");
    }
    const grants = this.store.entries().map((g) => ({
      id: g.rec.id, scope: g.rec.scope, action: g.rec.action, conditions: g.rec.conditions, created: g.rec.created, expires: g.rec.expires,
      max_uses: g.rec.max_uses, uses: g.uses.length, status: this.statusOf(g, kbRevoked), device_id: g.rec.device_id,
    }));
    return { grants, warnings };
  }

  // ---- use

  private async kbRevoked(): Promise<Set<string>> {
    try {
      return new Set((await this.kb.list()).grants.filter((g) => g.revoked).map((g) => g.id));
    } catch {
      // The kb cannot say whether a grant was revoked there: nothing is done on its authority meanwhile.
      throw new ActionError(503, "bad_request", "github_unavailable");
    }
  }

  private live(kbRevoked: ReadonlySet<string>, ci: LiveChecks["ci"]): LiveChecks {
    return { device: (id) => this.d.devices.get(id), ci, findingsClear: this.findings, codexClear: this.codex, kbRevoked };
  }

  private pickOf(g: GrantEntry): GrantPick {
    const id = g.rec.id;
    return {
      grant_id: id,
      device_id: g.rec.device_id,
      reserve: (a) => this.store.reserve(id, a),
      release: (a) => this.store.release(id, a),
      guard: (actionId, task, f) => this.guard(id, actionId, task, f),
    };
  }

  /**
   * Right before an outward write: the grant must still be there, unrevoked (books and kb), unexpired, signed by a device that is still
   * active, in scope, its conditions true, and hold the use this very action reserved. (CI was looked at by the caller a moment ago.)
   */
  private async guard(grantId: string, actionId: string, task: TaskInfo, f: Record<string, string>): Promise<void> {
    const g = this.store.get(grantId);
    if (!g) throw new ActionError(409, "grant_invalid", "grant_missing");
    const kbRevoked = await this.kbRevoked();
    if (!g.uses.includes(actionId)) throw new ActionError(409, "grant_invalid", g.revoked_at ? "grant_revoked" : "grant_use_missing");
    let why: string | null;
    try {
      why = await grantProblem(g, task, f.kind!, this.live(kbRevoked, async () => true), this.d.now(), false);
    } catch {
      throw new ActionError(503, "bad_request", "github_unavailable");
    }
    if (why) throw new ActionError(409, "grant_invalid", why);
  }

  /**
   * A gate card appeared (or is still waiting): if a grant covers it, carry it out through the approval path's exit; otherwise null and the card
   * stays for a person. Refusals of the live checks (`head_moved`, `not_mergeable`...) throw; callers that run unattended log them.
   */
  async tryTask(taskId: string): Promise<Approved | null> {
    const task = await this.d.tasks(taskId);
    if (!task || task.state !== "awaiting_approval" || !task.pr) return null;
    const card = await this.d.projects(task.project);
    if (!card?.repo) return null;
    const { kind } = gateKindOf(task, card);
    // Cheap test first: with no grant of this kind and scope in the books, GitHub is never asked.
    if (!this.store.entries().some((g) => g.rec.action === kind && scopeMatches(g.rec.scope, task))) return null;
    const kbRevoked = await this.kbRevoked();
    return this.d.svc.executeGranted(taskId, async (facts) => {
      const g = await evaluateGrants(facts.task, this.store.entries(), this.live(kbRevoked, async () => true /* executeGranted looked: green */), this.d.now());
      return g ? this.pickOf(g) : null;
    });
  }

  /** Fire and forget for events; `settled()` waits. */
  onTaskAwaiting(taskId: string): void {
    const p = this.tryTask(taskId).catch((e) => this.log(`grant ${taskId}: ${e instanceof ActionError ? `${e.code}/${String(e.details?.reason)}` : (e as Error).message}`));
    const q = p.finally(() => this.background.delete(q));
    this.background.add(q);
  }

  async settled(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  /** Every task still waiting (CI may have turned green since the card appeared), then unfinished grant actions. One sweep at a time. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      let ids: string[] = [];
      try {
        ids = await (this.d.config?.listAwaiting ?? vladAwaiting)();
      } catch (e) {
        this.log(`grant sweep: ${(e as Error).message}`);
      }
      for (const id of ids) {
        try {
          await this.tryTask(id);
        } catch (e) {
          this.log(`grant ${id}: ${e instanceof ActionError ? `${e.code}/${String(e.details?.reason)}` : (e as Error).message}`);
        }
      }
      await this.d.svc.resumeGranted((gid) => {
        const g = this.store.get(gid);
        return g ? this.pickOf(g) : null;
      });
    } finally {
      this.sweeping = false;
    }
  }

  start(): () => void {
    const every = this.d.config?.sweepMs;
    if (!every) return () => {};
    const run = () => void this.sweep().catch((e) => this.log(`grant sweep: ${(e as Error).message}`));
    run();
    this.timer = setInterval(run, every);
    this.timer.unref();
    return () => clearInterval(this.timer);
  }
}
