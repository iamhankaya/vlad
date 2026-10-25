import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GRANT_MAX_MS, kbPaths, nowIso, NON_DELEGABLE_ACTIONS, readDoc, validate, writeDoc } from "../kb/index.js";
import { safeAppendFile } from "../kb/safefs.js";
import type { GrantData } from "../kb/index.js";

export type Grant = { data: GrantData; file: string };

const FILE = /^G-(\d{3}|[1-9]\d{3,})\.md$/;
const ID = /^G-(\d{3}|[1-9]\d{3,})$/;
/** `created` may lead the server clock by this much (clock skew); further ahead would stretch the 30-day cap. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const grantFile = (id: string) => join(kbPaths().grants, `${id}.md`);

/**
 * The exact string a device signs (`vlad-grant/v2\nid=..\n...`, no trailing newline). `conditions` are sorted so
 * the same grant always signs the same bytes; `revoked` and `device_id` are not signed (revocation is a
 * server-side reduction, the device comes from the signed envelope). `project` and `repo` ARE signed (v2): a grant
 * binds the project card and repo it was given for. Without `payload_version` (the historical v1 vectors of
 * `contract/signing-vectors.json`) the old format without those two lines is produced; new records are v2 only.
 * Pure: S10a verifies against this.
 */
export function grantSigningPayload(g: Pick<GrantData, "id" | "scope" | "action" | "conditions" | "created" | "expires" | "max_uses"> & { project?: string; repo?: string; payload_version?: string }): string {
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

/** Schema plus what a schema cannot say: delegable action (checked first, in code), created < expires <= created + 30 d. */
function check(raw: unknown): GrantData {
  const action = (raw as { action?: unknown } | null)?.action;
  if (typeof action === "string" && (NON_DELEGABLE_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`not_delegable: "${action}" devredilemez`);
  }
  validate("grant", raw);
  const g = raw as GrantData;
  for (const t of [g.created, g.expires]) {
    const iso = new Date(t).toISOString();
    if (iso !== t && iso.replace(".000Z", "Z") !== t) throw new Error(`geçersiz tarih: ${t}`);
  }
  const span = Date.parse(g.expires) - Date.parse(g.created);
  if (!(span > 0)) throw new Error("expires, created'dan sonra olmalı");
  if (span > GRANT_MAX_MS) throw new Error("devir en çok 30 gün geçerli olabilir (expires - created <= 30 gün)");
  return g;
}

/**
 * Append-only revocation log `kb/grants/.revoked` (one JSON line per revoked grant: id and sha256 of its
 * signature). Deleting a grant file and re-adding the same signed JSON must not undo a revoke, so `add` refuses
 * a tombstoned id or signature and `list` lets the tombstone win over the file's `revoked: false`.
 * Server-side permanent revocation is S10a; kb is not a trust boundary.
 */
const tombFile = () => join(kbPaths().grants, ".revoked");
const sigHash = (sig: unknown) => createHash("sha256").update(typeof sig === "string" ? sig : "").digest("hex");
function tombstones(): { ids: Set<string>; sigs: Set<string> } {
  const ids = new Set<string>();
  const sigs = new Set<string>();
  if (!existsSync(tombFile())) return { ids, sigs };
  for (const line of readFileSync(tombFile(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as { id?: string; sig_sha256?: string };
      if (t.id) ids.add(t.id);
      if (t.sig_sha256) sigs.add(t.sig_sha256);
    } catch { /* an unreadable line revokes nothing and blocks nothing */ }
  }
  return { ids, sigs };
}

/** Every readable grant in id order; an unreadable or invalid file becomes a warning (`<file>: <reason>`). */
function readAll(): { grants: Grant[]; warnings: string[] } {
  const grants: Grant[] = [];
  const warnings: string[] = [];
  const dir = kbPaths().grants;
  if (!existsSync(dir)) return { grants, warnings };
  const tomb = tombstones();
  for (const name of readdirSync(dir).filter((f) => FILE.test(f)).sort((a, b) => num(a) - num(b))) {
    const file = join(dir, name);
    try {
      const data = check(readDoc<GrantData>(file).data);
      if (`${data.id}.md` !== name) throw new Error(`dosya adı id ile uyuşmuyor (${data.id})`);
      grants.push({ data: tomb.ids.has(data.id) || tomb.sigs.has(sigHash(data.signature)) ? { ...data, revoked: true } : data, file });
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { grants, warnings };
}
const num = (name: string) => Number(/^G-(\d+)\.md$/.exec(name)![1]);

/**
 * Writes `kb/grants/<id>.md` after a format check only; the signature is NOT verified here (the API does that on
 * every use, S10a). Call inside withKbLock (defWrite does): the duplicate check and the write are one critical section.
 */
export function addGrant(raw: unknown, now: Date = new Date()): Grant {
  const data = check(raw);
  if (Date.parse(data.created) > now.getTime() + FUTURE_SKEW_MS) throw new Error("created gelecekte olamaz (en çok 5 dk saat farkı)");
  const tomb = tombstones();
  if (tomb.ids.has(data.id) || tomb.sigs.has(sigHash(data.signature))) throw new Error(`devir iptal edilmiş: ${data.id}`);
  const file = grantFile(data.id);
  if (existsSync(file)) throw new Error(`devir zaten var: ${data.id}`);
  mkdirSync(kbPaths().grants, { recursive: true });
  writeDoc(file, data, "");
  return { data, file };
}

/** Grants in id order; `active` keeps those neither revoked nor expired and already created at `now`. */
export function listGrants(f: { active?: boolean; now?: Date } = {}): { grants: Grant[]; warnings: string[]; revoked_ids: string[] } {
  const { grants, warnings } = readAll();
  const now = (f.now ?? new Date()).getTime();
  // Tombstoned ids are reported on their own: a revoked grant whose file is damaged or gone is not in `grants` but must stay revoked.
  return { grants: f.active ? grants.filter((g) => !g.data.revoked && Date.parse(g.data.created) <= now && Date.parse(g.data.expires) > now) : grants, warnings, revoked_ids: [...tombstones().ids].sort() };
}

/**
 * Revokes by id alone: needs only the file (matching id), not a schema-valid record, so a damaged grant can still be
 * revoked. Writes the tombstone first, then sets `revoked: true` in the file (best effort); nothing else changes.
 * Revoking twice is a no-op. There is no way back.
 */
export function revokeGrant(id: string, now: Date = new Date()): Grant {
  if (!ID.test(id)) throw new Error(`geçersiz devir id'si: "${id}"`);
  const file = grantFile(id);
  if (!existsSync(file)) throw new Error(`devir bulunamadı: ${id}`);
  let doc: { data: Record<string, unknown>; body: string } | undefined;
  try {
    doc = readDoc<Record<string, unknown>>(file);
    if (doc.data.id !== id) doc = undefined;
  } catch { /* unreadable: the tombstone still revokes it */ }
  if (!tombstones().ids.has(id)) {
    safeAppendFile(tombFile(), JSON.stringify({ id, ...(typeof doc?.data.signature === "string" ? { sig_sha256: sigHash(doc.data.signature) } : {}), at: nowIso(now) }) + "\n");
  }
  if (doc && doc.data.revoked !== true) writeDoc(file, { ...doc.data, revoked: true }, doc.body);
  return { data: { ...(doc?.data ?? { id }), revoked: true } as GrantData, file };
}
