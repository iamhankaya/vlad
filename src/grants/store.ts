import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GRANT_MAX_MS, kbPaths, NON_DELEGABLE_ACTIONS, readDoc, validate, writeDoc } from "../kb/index.js";
import type { GrantData } from "../kb/index.js";

export type Grant = { data: GrantData; file: string };

const FILE = /^G-\d{3,}\.md$/;
const grantFile = (id: string) => join(kbPaths().grants, `${id}.md`);

/**
 * The exact string a device signs (`vlad-grant/v1\nid=..\n...`, no trailing newline). `conditions` are sorted so
 * the same grant always signs the same bytes; `revoked` and `device_id` are not signed (revocation is a
 * server-side reduction, the device comes from the signed envelope). Pure: S10a verifies against this.
 */
export function grantSigningPayload(g: Pick<GrantData, "id" | "scope" | "action" | "conditions" | "created" | "expires" | "max_uses">): string {
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

/** Schema plus what a schema cannot say: delegable action (checked first, in code), created < expires <= created + 30 d. */
function check(raw: unknown): GrantData {
  const action = (raw as { action?: unknown } | null)?.action;
  if (typeof action === "string" && (NON_DELEGABLE_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`not_delegable: "${action}" devredilemez`);
  }
  validate("grant", raw);
  const g = raw as GrantData;
  const span = Date.parse(g.expires) - Date.parse(g.created);
  if (!(span > 0)) throw new Error("expires, created'dan sonra olmalı");
  if (span > GRANT_MAX_MS) throw new Error("devir en çok 30 gün geçerli olabilir (expires - created <= 30 gün)");
  return g;
}

/** Every readable grant in id order; an unreadable or invalid file becomes a warning (`<file>: <reason>`). */
function readAll(): { grants: Grant[]; warnings: string[] } {
  const grants: Grant[] = [];
  const warnings: string[] = [];
  const dir = kbPaths().grants;
  if (!existsSync(dir)) return { grants, warnings };
  for (const name of readdirSync(dir).filter((f) => FILE.test(f)).sort((a, b) => num(a) - num(b))) {
    const file = join(dir, name);
    try {
      const data = check(readDoc<GrantData>(file).data);
      if (`${data.id}.md` !== name) throw new Error(`dosya adı id ile uyuşmuyor (${data.id})`);
      grants.push({ data, file });
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
export function addGrant(raw: unknown): Grant {
  const data = check(raw);
  const file = grantFile(data.id);
  if (existsSync(file)) throw new Error(`devir zaten var: ${data.id}`);
  mkdirSync(kbPaths().grants, { recursive: true });
  writeDoc(file, data, "");
  return { data, file };
}

/** Grants in id order; `active` keeps those neither revoked nor expired at `now`. */
export function listGrants(f: { active?: boolean; now?: Date } = {}): { grants: Grant[]; warnings: string[] } {
  const { grants, warnings } = readAll();
  const now = (f.now ?? new Date()).getTime();
  return { grants: f.active ? grants.filter((g) => !g.data.revoked && Date.parse(g.data.expires) > now) : grants, warnings };
}

/** Sets `revoked: true` and changes nothing else; revoking twice is a no-op. There is no way back. */
export function revokeGrant(id: string): Grant {
  if (!/^G-\d{3,}$/.test(id)) throw new Error(`geçersiz devir id'si: "${id}"`);
  const file = grantFile(id);
  if (!existsSync(file)) throw new Error(`devir bulunamadı: ${id}`);
  const doc = readDoc<GrantData>(file);
  const data = check(doc.data);
  if (!data.revoked) writeDoc(file, { ...data, revoked: true }, doc.body);
  return { data: { ...data, revoked: true }, file };
}
