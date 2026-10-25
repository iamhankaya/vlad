import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addGrant, grantSigningPayload, listGrants, revokeGrant } from "../../src/grants/store.js";
import { readDoc, withKbLock } from "../../src/kb/index.js";
import { readVault, searchVault } from "../../src/vault/search.js";
import { activeFile } from "../../src/active/store.js";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
beforeEach(() => {
  home = makeHome();
});

const vlad = (args: string[], env: Record<string, string> = {}, input?: string) => {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", input, env: { ...process.env, VLAD_HOME: home, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// relative to the real clock (add refuses a `created` in the future); whole seconds, strict UTC form
const T0 = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const CREATED = iso(T0);
const grant = (over: Record<string, unknown> = {}) => ({
  id: "G-001",
  scope: { type: "project", ref: "vlad" },
  action: "merge_phase",
  conditions: ["ci_green", "no_severe_findings"],
  created: CREATED,
  expires: iso(T0 + 7 * 86_400_000),
  max_uses: 3,
  revoked: false,
  device_id: "D-1",
  payload_version: "v1",
  ...over,
  // one signature per grant, as in life (a revoke tombstones the signature too)
  signature: (over.signature as string | undefined) ?? `c2ln-${over.id ?? "G-001"}`,
});
const grantDir = () => join(home, "kb", "grants");
const plus = (ms: number) => iso(T0 + ms);
const DAY = 86_400_000;

describe("records: grant", () => {
  it("records: grant max 30 days (exact 30d accepted, +1s rejected)", () => {
    addGrant(grant({ expires: plus(30 * DAY) }));
    expect(existsSync(join(grantDir(), "G-001.md"))).toBe(true);
    expect(() => addGrant(grant({ id: "G-002", expires: plus(30 * DAY + 1000) }))).toThrow(/30 gün/);
    expect(() => addGrant(grant({ id: "G-003", expires: CREATED }))).toThrow(/sonra/);
    expect(() => addGrant(grant({ id: "G-004", expires: plus(-1000) }))).toThrow(/sonra/);
    expect(existsSync(join(grantDir(), "G-002.md"))).toBe(false);
  });

  it("records: grant requires ci_green", () => {
    for (const conditions of [[], ["no_severe_findings"], ["codex_clear", "no_severe_findings"]]) {
      expect(() => addGrant(grant({ conditions }))).toThrow(/doğrulama hatası/);
    }
    expect(() => addGrant(grant({ conditions: ["ci_green", "ci_green"] }))).toThrow(/doğrulama hatası/);
    expect(() => addGrant(grant({ conditions: ["ci_green", "mystery"] }))).toThrow(/doğrulama hatası/);
    addGrant(grant({ conditions: ["ci_green", "no_severe_findings", "codex_clear"] }));
  });

  it("records: grant non-delegable action rejected by schema enum and by code", () => {
    for (const action of ["tag_release", "publish", "delete", "security", "scope_change"]) {
      expect(() => addGrant(grant({ action }))).toThrow(/not_delegable/);
    }
    // the schema alone also refuses them (enum), independent of the code check
    const schema = JSON.parse(readFileSync(join(resolve(import.meta.dirname, "..", ".."), "schemas", "grant.schema.json"), "utf8"));
    expect(schema.properties.action.enum).toEqual(["merge_phase", "merge_final"]);
    expect(() => addGrant(grant({ action: "format_disk" }))).toThrow(/doğrulama hatası/);
    addGrant(grant({ action: "merge_final" }));
    expect(readdirSync(grantDir())).toEqual(["G-001.md"]);
  });

  it("records: grant rejects malformed records", () => {
    for (const bad of [
      grant({ id: "G-1" }), grant({ max_uses: 0 }), grant({ max_uses: 1.5 }), grant({ payload_version: "v2" }),
      grant({ scope: { type: "repo", ref: "x" } }), grant({ scope: { type: "project", ref: "a\nb" } }),
      grant({ extra: 1 }), grant({ created: "yesterday" }), grant({ signature: "" }), grant({ device_id: "" }),
    ]) {
      expect(() => addGrant(bad)).toThrow(/doğrulama hatası/);
    }
    addGrant(grant());
    expect(() => addGrant(grant())).toThrow(/zaten var/);
  });

  it("records: grant revoke only reduces", () => {
    addGrant(grant());
    const before = readDoc(join(grantDir(), "G-001.md")).data as Record<string, unknown>;
    revokeGrant("G-001");
    revokeGrant("G-001"); // idempotent
    const after = readDoc(join(grantDir(), "G-001.md")).data as Record<string, unknown>;
    expect(after).toEqual({ ...before, revoked: true });
    expect(() => revokeGrant("G-404")).toThrow(/bulunamadı/);
    expect(() => revokeGrant("../x")).toThrow(/geçersiz/);
    expect(() => addGrant(grant({ revoked: false }))).toThrow(/zaten var|iptal/); // no way to re-create/un-revoke
  });

  it("records: grant list --active hides revoked and expired; corrupt file is a warning", () => {
    addGrant(grant({ id: "G-001" }));
    addGrant(grant({ id: "G-002" }));
    addGrant(grant({ id: "G-003", expires: plus(DAY) }));
    revokeGrant("G-002");
    writeFileSync(join(grantDir(), "G-004.md"), "---\nid: G-004\n---\n");
    const now = new Date(T0 + 2 * DAY);
    expect(listGrants({ now }).grants.map((g) => g.data.id)).toEqual(["G-001", "G-002", "G-003"]);
    const act = listGrants({ active: true, now });
    expect(act.grants.map((g) => g.data.id)).toEqual(["G-001"]);
    expect(act.warnings).toHaveLength(1);
    expect(act.warnings[0]).toMatch(/^G-004\.md:/);
  });

  it("records: grant signing payload is canonical", () => {
    const g = grant({ conditions: ["no_severe_findings", "ci_green"] }) as never;
    expect(grantSigningPayload(g)).toBe(
      [
        "vlad-grant/v1", "id=G-001", "scope=project:vlad", "action=merge_phase", "conditions=ci_green,no_severe_findings",
        `created=${CREATED}`, `expires=${plus(7 * DAY)}`, "max_uses=3",
      ].join("\n"),
    );
    // unsigned/untouched fields do not change the bytes; signed ones do
    expect(grantSigningPayload({ ...(g as object), revoked: true, device_id: "D-9", signature: "x" } as never)).toBe(grantSigningPayload(g));
    for (const change of [{ id: "G-002" }, { max_uses: 4 }, { action: "merge_final" }, { scope: { type: "pipeline", ref: "vlad" } }, { expires: plus(DAY) }]) {
      expect(grantSigningPayload({ ...(g as object), ...change } as never)).not.toBe(grantSigningPayload(g));
    }
    expect(grantSigningPayload(g).endsWith("\n")).toBe(false);
  });

  it("records: grant created in the future rejected; list --active needs created <= now", () => {
    expect(() => addGrant(grant({ created: plus(2 * 3_600_000 + 3_600_000), expires: plus(10 * DAY) }))).toThrow(/gelecekte/);
    expect(() => addGrant(grant({ id: "G-002", created: iso(Date.now() + 10 * 60_000), expires: iso(Date.now() + 20 * 60_000) }))).toThrow(/gelecekte/);
    // within the 5 min skew it is accepted, but not active until `created`
    const soon = Math.floor(Date.now() / 1000) * 1000 + 3 * 60_000;
    addGrant(grant({ id: "G-003", created: iso(soon), expires: iso(soon + DAY) }));
    expect(listGrants({ active: true }).grants.map((g) => g.data.id)).toEqual([]);
    expect(listGrants({ active: true, now: new Date(soon + 1000) }).grants.map((g) => g.data.id)).toEqual(["G-003"]);
  });

  it("records: grant revoke survives delete and re-add of the signed JSON (tombstone)", () => {
    addGrant(grant());
    revokeGrant("G-001");
    expect(readFileSync(join(grantDir(), ".revoked"), "utf8")).toMatch(/"id":"G-001","sig_sha256":"[0-9a-f]{64}"/);
    rmSync(join(grantDir(), "G-001.md"));
    expect(() => addGrant(grant())).toThrow(/iptal edilmiş/);
    // same signature under a new id is refused too
    expect(() => addGrant(grant({ id: "G-002", signature: grant().signature }))).toThrow(/iptal edilmiş/);
    // a file smuggled in by hand with revoked:false is still listed as revoked
    writeFileSync(join(grantDir(), "G-001.md"), "---\n" + Object.entries(grant()).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n---\n");
    expect(listGrants().grants[0]!.data.revoked).toBe(true);
    expect(listGrants({ active: true }).grants).toHaveLength(0);
  });

  it("records: grant revoke works on a damaged file by id alone", () => {
    mkdirSync(grantDir(), { recursive: true });
    writeFileSync(join(grantDir(), "G-007.md"), "---\nid: G-007\nmax_uses: nonsense\n---\n");
    revokeGrant("G-007");
    expect(readDoc<{ revoked: boolean }>(join(grantDir(), "G-007.md")).data.revoked).toBe(true);
    expect(readFileSync(join(grantDir(), ".revoked"), "utf8")).toContain('"id":"G-007"');
    writeFileSync(join(grantDir(), "G-008.md"), "not frontmatter at all");
    revokeGrant("G-008");
    expect(readFileSync(join(grantDir(), ".revoked"), "utf8")).toContain('"id":"G-008"');
  });

  it("records: grant dates strict UTC and round-trip; id canonical; max_uses capped", () => {
    for (const bad of [
      grant({ created: "2026-10-25T10:00:00+03:00" }), grant({ created: plus(0).replace("Z", "+00:00") }),
      grant({ created: "2026-02-31T10:00:00Z" }), grant({ expires: "2026-13-01T10:00:00Z" }),
      grant({ id: "G-0001" }), grant({ id: "G-01" }), grant({ max_uses: 1001 }),
    ]) {
      expect(() => addGrant(bad)).toThrow();
    }
    addGrant(grant({ id: "G-1000", max_uses: 1000, created: CREATED.replace("Z", ".000Z") }));
    addGrant(grant({ id: "G-002", created: CREATED.replace("Z", ".123Z"), expires: plus(DAY) }));
  });

  it("records: grant CLI add/list/revoke with --json errors", () => {
    const f = join(home, "g.json");
    writeFileSync(f, JSON.stringify(grant()));
    expect(vlad(["grant", "add", "--file", f, "--json"]).code).toBe(0);
    expect(JSON.parse(vlad(["grant", "list", "--json"]).out).grants).toHaveLength(1);
    const bad = vlad(["grant", "add", "--file", "-", "--json"], {}, JSON.stringify(grant({ id: "G-002", action: "publish" })));
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).error).toMatch(/not_delegable/);
    expect(vlad(["grant", "revoke", "G-001", "--json"]).code).toBe(0);
    expect(JSON.parse(vlad(["grant", "list", "--active", "--json"]).out).grants).toHaveLength(0);
    expect(vlad(["grant", "revoke", "G-009"]).code).toBe(1);
  });
});

describe("records: separate kb repo (kbDir)", () => {
  let kb: string;
  beforeEach(() => {
    kb = mkdtempSync(join(tmpdir(), "vlad-kbrepo-"));
    for (const d of ["projects", "docs"]) mkdirSync(join(kb, d), { recursive: true });
    writeFileSync(join(kb, "projects", "demo.md"), "# Demo\n\nkbdir-marker burada\n");
    writeFileSync(join(kb, "decisions.md"), "# Kararlar\n");
    process.env.VLAD_KB_DIR = kb;
  });

  it("records: kbDir equal to or above VLAD_HOME is an explicit error", () => {
    process.env.VLAD_KB_DIR = home;
    expect(() => readVault("kb/x.md")).toThrow();
    const r = vlad(["grant", "list", "--json"], { VLAD_KB_DIR: join(home, "..") });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/atası olamaz/);
    expect(vlad(["grant", "list", "--json"], { VLAD_KB_DIR: home }).err).toMatch(/atası olamaz/);
  });

  it("records: grants resolve under kbDir, not <home>/kb", () => {
    addGrant(grant());
    expect(existsSync(join(kb, "grants", "G-001.md"))).toBe(true);
    expect(existsSync(join(home, "kb", "grants"))).toBe(false);
    const r = vlad(["grant", "add", "--file", "-", "--json"], { VLAD_KB_DIR: kb }, JSON.stringify(grant({ id: "G-002" })));
    expect(r.code).toBe(0);
    expect(readdirSync(join(kb, "grants")).sort()).toEqual(["G-001.md", "G-002.md"]);
  });

  it("records: withKbLock lock file lives in kbDir", async () => {
    await withKbLock(() => {
      expect(existsSync(join(kb, ".vlad.lock"))).toBe(true);
      expect(existsSync(join(home, "kb", ".vlad.lock"))).toBe(false);
    });
    expect(existsSync(join(kb, ".vlad.lock"))).toBe(false);
  });

  it("records: active.md lives in kbDir and CLI claim writes there", () => {
    expect(activeFile()).toBe(join(kb, "active.md"));
    const r = vlad(["active", "claim", "--json"], { VLAD_KB_DIR: kb });
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(kb, "active.md"))).toBe(true);
    expect(existsSync(join(home, "kb", "active.md"))).toBe(false);
  });

  it("records: vault reads and searches the kbDir checkout under the kb/ prefix", () => {
    expect(readVault("kb/projects/demo.md").content).toContain("kbdir-marker");
    const hits = searchVault("kbdir-marker", { zone: "kb" }).hits;
    expect(hits.map((h) => h.path)).toEqual(["kb/projects/demo.md"]);
    writeFileSync(join(kb, "projects", ".hidden.md"), "kbdir-marker");
    mkdirSync(join(kb, "grants"), { recursive: true });
    writeFileSync(join(kb, "grants", "G-1.md"), "kbdir-marker");
    mkdirSync(join(kb, "inbox"), { recursive: true });
    writeFileSync(join(kb, "inbox", "x.md"), "kbdir-marker");
    expect(searchVault("kbdir-marker").hits.map((h) => h.path)).toEqual(["kb/projects/demo.md"]);
    for (const p of ["kb/grants/G-1.md", "kb/inbox/x.md", "KB/INBOX/x.md", "kb/projects/.hidden.md"]) expect(() => readVault(p)).toThrow();
    // a symlink inside the checkout cannot reach a forbidden folder or leave the checkout
    symlinkSync(join(kb, "grants", "G-1.md"), join(kb, "projects", "link.md"));
    expect(() => readVault("kb/projects/link.md")).toThrow();
    // a link in vault/docs must not reach the stale <home>/kb of a separate-kb setup
    mkdirSync(join(home, "kb", "projects"), { recursive: true });
    writeFileSync(join(home, "kb", "projects", "stale.md"), "stale");
    mkdirSync(join(home, "vault", "docs"), { recursive: true });
    symlinkSync(join(home, "kb", "projects", "stale.md"), join(home, "vault", "docs", "stale.md"));
    expect(() => readVault("vault/docs/stale.md")).toThrow(/kök dışına|izin listesinde/);
    expect(searchVault("stale", { zone: "docs" }).hits).toEqual([]);
    writeFileSync(join(home, "outside.md"), "secret");
    symlinkSync(join(home, "outside.md"), join(kb, "projects", "out.md"));
    expect(() => readVault("kb/projects/out.md")).toThrow();
  });
});
