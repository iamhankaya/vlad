import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
/** Active grants (not revoked, not expired): a device that went wild cannot pile up live authority without bound. Dead ones do not count (they shrink to tombstones). */
export const MAX_GRANTS = 200;

/** A grant as the phone signed it, plus the device that signed (the one from the verified envelope, never from the body). */
export type GrantRecord = {
  id: string;
  scope: { type: "project" | "pipeline"; ref: string };
  /** Project card slug and the repo registered on it, both signed (v2): a use needs the card to say exactly this. */
  project: string;
  repo: string;
  action: string;
  conditions: string[];
  created: string;
  expires: string;
  max_uses: number;
  signature: string;
  payload_version: "v2";
  device_id: string;
};
export type GrantEntry = { rec: GrantRecord; revoked_at?: string; /** Action ids that took a use. */ uses: string[] };
export type GrantStatus = "active" | "expired" | "revoked" | "device_revoked" | "exhausted";

/**
 * The exact string a device signs (`vlad-grant/v2\nid=..\n...`, no trailing newline; vector: `signing-vectors.json` `grant`). `conditions` are
 * sorted so the same grant always signs the same bytes. `project` and `repo` are signed; `device_id` and `revoked` are not (the device comes
 * from the envelope). An input without `payload_version: "v2"` gives the historical v1 bytes (the old vectors only); the server accepts v2 alone.
 */
export function grantSigningPayload(g: Pick<GrantRecord, "id" | "scope" | "action" | "conditions" | "created" | "expires" | "max_uses"> & { project?: string; repo?: string; payload_version?: string }): string {
  const v2 = g.payload_version === "v2";
  return [
    v2 ? "vlad-grant/v2" : "vlad-grant/v1",
    `id=${g.id}`,
    `scope=${g.scope.type}:${g.scope.ref}`,
    ...(v2 ? [`project=${g.project}`, `repo=${g.repo}`] : []),
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

const KEYS = ["id", "scope", "project", "repo", "action", "conditions", "created", "expires", "max_uses", "signature", "payload_version"];
const ID = /^G-([0-9]{3}|[1-9][0-9]{3,})$/;
const REF = /^[A-Za-z0-9._-]{1,200}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REPO = /^(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
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
  if (typeof raw.project !== "string" || !PROJECT.test(raw.project)) throw new GrantRefusal(400, "bad_request", "bad_field", "project");
  if (typeof raw.repo !== "string" || raw.repo.length > 200 || !REPO.test(raw.repo)) throw new GrantRefusal(400, "bad_request", "bad_field", "repo");
  const c = raw.conditions;
  if (!Array.isArray(c) || c.length > GRANT_CONDITIONS.length || c.some((x) => typeof x !== "string" || !(GRANT_CONDITIONS as readonly string[]).includes(x)) || new Set(c).size !== c.length || !c.includes("ci_green")) {
    throw new GrantRefusal(400, "bad_request", "bad_field", "conditions");
  }
  const created = parseTs(raw.created, "created");
  const expires = parseTs(raw.expires, "expires");
  if (!Number.isSafeInteger(raw.max_uses) || (raw.max_uses as number) < 1 || (raw.max_uses as number) > 1000) throw new GrantRefusal(400, "bad_request", "bad_field", "max_uses");
  if (raw.payload_version !== "v2") throw new GrantRefusal(400, "bad_request", "bad_field", "payload_version");
  if (!decodeB64url(raw.signature, 100)) throw new GrantRefusal(400, "bad_request", "bad_field", "signature");

  if (!(expires > created)) throw new GrantRefusal(422, "grant_invalid", "expires_before_created");
  if (expires - created > GRANT_MAX_MS) throw new GrantRefusal(422, "grant_invalid", "longer_than_30_days");
  if (Math.abs(created - nowMs) > CREATED_WINDOW_MS) throw new GrantRefusal(422, "grant_invalid", "created_out_of_window");
  if (expires <= nowMs) throw new GrantRefusal(422, "grant_invalid", "already_expired");
  return {
    id: raw.id, scope: { type: s.type, ref: s.ref }, project: raw.project, repo: raw.repo, action, conditions: c as string[], created: raw.created as string, expires: raw.expires as string,
    max_uses: raw.max_uses as number, signature: raw.signature as string, payload_version: "v2",
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
  /** Dead grants (revoked or expired) shrunk to what keeps them dead: their id and the hash of their signature. Never forgotten. */
  private tombs: { id: string; sig: string }[] = [];

  constructor(stateDir: string) {
    ensureDir(stateDir);
    this.grantsFile = join(stateDir, "grants.json");
    this.usesFile = join(stateDir, "grant-uses.json");
    const uses = readJsonFile<{ uses: Record<string, string[]> }>(this.usesFile)?.uses ?? {};
    const saved = readJsonFile<{ grants: { rec: GrantRecord; revoked_at?: string }[]; tombstones?: { id: string; sig: string }[] }>(this.grantsFile);
    for (const g of saved?.grants ?? []) {
      this.byId.set(g.rec.id, { rec: g.rec, ...(g.revoked_at ? { revoked_at: g.revoked_at } : {}), uses: [...(uses[g.rec.id] ?? [])] });
    }
    this.tombs = saved?.tombstones ?? [];
  }

  get(id: string): GrantEntry | undefined {
    return this.byId.get(id);
  }
  /** In id order. */
  entries(): GrantEntry[] {
    return [...this.byId.values()].sort((a, b) => a.rec.id.localeCompare(b.rec.id, "en", { numeric: true }));
  }
  /** Why this id or signature cannot be taken again (seen before: live, dead, or shrunk to a tombstone), or null. */
  taken(id: string, signature: string): "id_taken" | "signature_reused" | null {
    const h = sigHash(signature);
    if (this.byId.has(id) || this.tombs.some((t) => t.id === id)) return "id_taken";
    if (this.tombs.some((t) => t.sig === h) || [...this.byId.values()].some((g) => sigHash(g.rec.signature) === h)) return "signature_reused";
    return null;
  }
  has(id: string, signature: string): boolean {
    return this.taken(id, signature) !== null;
  }
  get size(): number {
    return this.byId.size;
  }
  get tombstones(): number {
    return this.tombs.length;
  }
  private dead(g: GrantEntry, nowMs: number): boolean {
    return !!g.revoked_at || nowMs >= Date.parse(g.rec.expires);
  }
  /** Grants that can still act: not revoked, not expired. */
  activeCount(nowMs: number): number {
    return this.entries().filter((g) => !this.dead(g, nowMs)).length;
  }

  /** Stores a grant. Once the books hold {@link MAX_GRANTS} entries, dead ones that took no use shrink to tombstones first (a used one stays: its action may still be finishing). */
  add(rec: GrantRecord, nowMs: number): void {
    if (this.byId.size >= MAX_GRANTS) {
      for (const g of this.entries()) {
        if (this.dead(g, nowMs) && g.uses.length === 0) {
          this.tombs.push({ id: g.rec.id, sig: sigHash(g.rec.signature) });
          this.byId.delete(g.rec.id);
        }
      }
    }
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
    writeJsonAtomic(this.grantsFile, { v: 1, grants: this.entries().map((g) => ({ rec: g.rec, ...(g.revoked_at ? { revoked_at: g.revoked_at } : {}) })), tombstones: this.tombs });
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
  /** Grants the kb revokes, or that it cannot vouch for (see {@link GrantEngine}): reduces only. */
  kbRevoked: ReadonlySet<string>;
  /** The repo registered on the project card right now. */
  cardRepo: string | undefined;
};

export const scopeMatches = (scope: GrantRecord["scope"], task: Pick<TaskInfo, "id" | "project" | "parent">): boolean =>
  scope.type === "project" ? task.project === scope.ref : (task.parent ?? task.id) === scope.ref;

/** Why `g` does not cover this task now (a stable key), or null. Project and repo must equal what was signed. `forSelection` also refuses a grant whose uses are all taken. */
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
  if (r.payload_version !== "v2" || !signatureHolds(r, dev)) return "grant_invalid";
  // What the grant was signed for must be exactly what the kb says now: a re-pointed task or card gets no grant.
  if (task.project !== r.project) return "project_mismatch";
  if (live.cardRepo !== r.repo) return "repo_mismatch";
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
  /** `revoked` as the kb says; `revoked_ids` are the kb's tombstones, valid whatever became of the grant file. */
  list(): Promise<{ grants: { id: string; revoked: boolean }[]; revoked_ids: string[]; warnings: string[] }>;
  revoke(id: string): Promise<void>;
}

export const vladGrantKb: GrantKb = {
  async add(rec) {
    await runVlad(["grant", "add", "--file", "-"], { input: JSON.stringify({ ...rec, revoked: false }) });
  },
  async list() {
    const r = await runVladJson<{ grants: { id: string; revoked?: boolean }[]; warnings?: string[]; revoked_ids?: string[] }>(["grant", "list"]);
    // A CLI that does not report tombstones cannot vouch for revocations: fail closed rather than assume none.
    if (!Array.isArray(r.revoked_ids)) throw new Error("vlad grant list: revoked_ids yok (eski CLI)");
    return { grants: r.grants.map((g) => ({ id: g.id, revoked: g.revoked === true })), revoked_ids: r.revoked_ids, warnings: r.warnings ?? [] };
  },
  async revoke(id) {
    if (!ID.test(id)) throw new Error("geçersiz devir id'si");
    await runVlad(["grant", "revoke", id]);
  },
};

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Clear = the CLI listed no open/deferred critical or high finding AND had nothing to complain about (a damaged finding file may hide one). */
export const vladFindingsClear = (log: (m: string) => void) => async (project: string): Promise<boolean> => {
  if (!SLUG.test(project)) return false;
  const kb = process.env.VLAD_KB_DIR ?? (process.env.VLAD_HOME ? join(process.env.VLAD_HOME, "kb") : undefined);
  if (kb && !existsSync(join(kb, "findings"))) log(`findings klasörü yok: ${join(kb, "findings")} (hiç bulgu kaydı yok sayılıyor)`);
  const r = await runVladJson<{ findings: unknown[]; warnings?: string[] }>(["finding", "list", `--project=${project}`, "--state=open,deferred", "--severity=kritik,yüksek"]);
  if ((r.warnings?.length ?? 0) > 0) {
    log(`findings uyarısı, no_severe_findings sağlanmadı: ${r.warnings!.join("; ")}`);
    return false;
  }
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
    this.findings = d.config?.findingsClear ?? vladFindingsClear((m) => this.log(m));
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
      const taken = this.store.taken(g.id, g.signature);
      if (taken) throw new GrantRefusal(409, "bad_request", taken);
      if (this.store.activeCount(this.d.now()) >= MAX_GRANTS) throw new GrantRefusal(409, "bad_request", "too_many_grants");
      const rec: GrantRecord = { ...g, device_id: deviceId };
      try {
        await this.kb.add(rec);
      } catch (e) {
        this.log(`grant add (kb): ${(e as Error).message}`);
        throw new GrantRefusal(503, "bad_request", "kb_unavailable");
      }
      this.store.add(rec, this.d.now());
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
      kbRevoked = this.revokedBy(k);
      warnings.push(...k.warnings);
      for (const x of k.grants) if (!this.store.get(x.id)) warnings.push(`kb'de kayıtsız devir yok sayıldı: ${x.id}`);
    } catch {
      warnings.push("kb devir listesi okunamadı");
    }
    const grants = this.store.entries().map((g) => ({
      id: g.rec.id, scope: g.rec.scope, project: g.rec.project, repo: g.rec.repo, action: g.rec.action, conditions: g.rec.conditions, created: g.rec.created, expires: g.rec.expires,
      max_uses: g.rec.max_uses, uses: g.uses.length, status: this.statusOf(g, kbRevoked), device_id: g.rec.device_id,
    }));
    return { grants, warnings };
  }

  // ---- use

  /**
   * What the kb takes away: grants it marks revoked, its tombstoned ids (valid even when the grant file is damaged or gone), and, when it
   * complains about anything at all (`warnings`), every grant of the books it does not list: it may be the damaged file that was revoked.
   */
  private revokedBy(k: Awaited<ReturnType<GrantKb["list"]>>): Set<string> {
    const out = new Set([...k.grants.filter((g) => g.revoked).map((g) => g.id), ...k.revoked_ids]);
    if (k.warnings.length > 0) {
      const listed = new Set(k.grants.map((g) => g.id));
      for (const g of this.store.entries()) if (!listed.has(g.rec.id)) out.add(g.rec.id);
    }
    return out;
  }

  private async kbRevoked(): Promise<Set<string>> {
    try {
      return this.revokedBy(await this.kb.list());
    } catch {
      // The kb cannot say whether a grant was revoked there: nothing is done on its authority meanwhile.
      throw new ActionError(503, "bad_request", "github_unavailable");
    }
  }

  private live(kbRevoked: ReadonlySet<string>, ci: LiveChecks["ci"], cardRepo: string | undefined): LiveChecks {
    return { device: (id) => this.d.devices.get(id), ci, findingsClear: this.findings, codexClear: this.codex, kbRevoked, cardRepo };
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
      const card = await this.d.projects(task.project);
      why = await grantProblem(g, task, f.kind!, this.live(kbRevoked, async () => true, card?.repo), this.d.now(), false);
    } catch {
      throw new ActionError(503, "bad_request", "github_unavailable");
    }
    if (why) throw new ActionError(409, "grant_invalid", why);
    // The awaits above gave a revocation time to land: look at the books and the device once more, synchronously, right before saying yes.
    if (this.store.get(grantId)?.revoked_at) throw new ActionError(409, "grant_invalid", "grant_revoked");
    const dev = this.d.devices.get(g.rec.device_id);
    if (!dev || dev.revoked_at) throw new ActionError(409, "grant_invalid", "device_revoked");
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
    if (!this.store.entries().some((g) => this.statusOf(g) === "active" && g.rec.action === kind && scopeMatches(g.rec.scope, task))) return null;
    const kbRevoked = await this.kbRevoked();
    return this.d.svc.executeGranted(taskId, async (facts) => {
      const g = await evaluateGrants(facts.task, this.store.entries(), this.live(kbRevoked, async () => true /* executeGranted looked: green */, facts.repo), this.d.now());
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
