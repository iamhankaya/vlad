// T1 kabul: S4a (grant) ve S4b (active) — plan §Kayıt şemaları `grant`/`active`, §S3b-S4 test adları.
// ATLANMIŞ (describe.skip): S4a (grant) güvenlik kararı bekliyor, S4b (active) henüz entegrasyonda değil; ikisi de uygulanmadı.
// Gövdeler plan arayüzünden yazıldı; uygulama gelince `describe.skip` -> `describe` yapılır ve (gerekirse) Test itirazı ile düzeltilir.
// Varsayımlar (planda belirtilmemiş, uygulama gelince doğrulanacak): `grant add --file` JSON'u `id` taşır ve `G-<NNN>` biçimindedir;
// imza yalnız biçim olarak doğrulanır (b64url); `grant list --json` {grants, warnings} döner.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fail, newHome, ok, run, runAsync, writeConfig, writeProjectCard } from "./helpers.js";

let home: string;
beforeEach(() => { home = newHome(); writeProjectCard(home); });

const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const grant = (o: Record<string, unknown> = {}, now = Date.now()) => ({
  id: "G-001", scope: { type: "project", ref: "alpha" }, action: "merge_phase", conditions: ["ci_green"],
  created: iso(now), expires: iso(now + 7 * day), max_uses: 3, revoked: false, device_id: "dev-1",
  signature: "c2lnbmF0dXJl", payload_version: "v1", ...o,
});
const add = (g: object) => run(home, ["grant", "add", "--file", "-", "--json"], { input: JSON.stringify(g) });

describe.skip("records: S4a — grant (uygulanmadı; güvenlik kararı bekliyor)", () => {
  it("records: grant max 30 days (exact 30d accepted, +1s rejected)", () => {
    const now = Date.now();
    expect(add(grant({ id: "G-001", expires: iso(now + 30 * day) }, now)).code).toBe(0);
    const r = add(grant({ id: "G-002", expires: iso(now + 30 * day + 1000) }, now));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toBeTruthy();
  });
  it("records: grant requires ci_green", () => {
    for (const conditions of [[], ["no_severe_findings"], ["codex_clear"]]) expect(add(grant({ conditions })).code).toBe(1);
    expect(add(grant({ conditions: ["ci_green", "no_severe_findings", "codex_clear"] })).code).toBe(0);
  });
  it("records: grant non-delegable action rejected by schema", () => {
    for (const action of ["tag_release", "publish", "delete", "security", "scope_change", "merge_everything"]) {
      expect(add(grant({ action })).code, action).toBe(1);
    }
    for (const action of ["merge_phase", "merge_final"]) expect(add(grant({ id: `G-${action === "merge_phase" ? "010" : "011"}`, action })).code).toBe(0);
  });
  it("grant scope type is project|pipeline only and payload_version must be v1", () => {
    expect(add(grant({ scope: { type: "global", ref: "*" } })).code).toBe(1);
    expect(add(grant({ payload_version: "v2" })).code).toBe(1);
    expect(add(grant({ max_uses: 0 })).code).toBe(1);
  });
  it("records: grant revoke only reduces (revoked stays; cannot be un-revoked; list --active hides it)", () => {
    expect(add(grant()).code).toBe(0);
    ok(home, ["grant", "revoke", "G-001"]);
    expect(ok<any>(home, ["grant", "list", "--active"]).grants).toEqual([]);
    expect(ok<any>(home, ["grant", "list"]).grants[0].revoked).toBe(true);
    // yeniden `add` ile aynı id üzerinden geri açılamaz
    expect(add(grant({ revoked: false })).code).toBe(1);
    expect(ok<any>(home, ["grant", "list"]).grants[0].revoked).toBe(true);
  });
  it("grant list --active hides expired grants (relative times)", () => {
    const now = Date.now();
    expect(add(grant({ id: "G-001", created: iso(now - 10 * day), expires: iso(now - 1000) }, now)).code).toBe(0);
    expect(ok<any>(home, ["grant", "list", "--active"]).grants).toEqual([]);
  });
  it("grant revoke of an unknown id errors", () => {
    fail(home, ["grant", "revoke", "G-999"]);
  });
});

describe("records: S4b — active", () => {
  const other = { VLAD_MACHINE: "baska-vlad" };
  it("active show/claim/heartbeat/release round trip", () => {
    ok(home, ["active", "claim"]);
    expect(ok<any>(home, ["active", "show"]).active.machine).toBe("t1box");
    ok(home, ["active", "heartbeat"]);
    ok(home, ["active", "release"]);
  });
  it("records: active other machine fresh -> error active_elsewhere on writing commands", () => {
    ok(home, ["active", "claim"], { env: other });
    const e = fail(home, ["card", "new", "--kind", "ci_red", "--project", "alpha", "--title", "x"]);
    expect(e.error).toMatch(/^active_elsewhere/);
    fail(home, ["quota", "set", "--until", iso(Date.now() + day), "--reason", "r"]);
    ok(home, ["card", "list"]); // okuma serbest
  });
  it("records: takeover refreshes (takeover_from set, writes allowed again)", () => {
    ok(home, ["active", "claim"], { env: other });
    ok(home, ["active", "claim", "--takeover"]);
    const a = ok<any>(home, ["active", "show"]);
    expect(a.active).toMatchObject({ machine: "t1box", takeover_from: "baska-vlad" });
    ok(home, ["card", "new", "--kind", "ci_red", "--project", "alpha", "--title", "x"]);
  });
  it("records: stale warns and continues (threshold 2 h, ±1 s)", () => {
    const setHeartbeat = (ms: number) => {
      const f = join(home, "kb", "active.md");
      writeFileSync(f, readFileSync(f, "utf8").replace(/heartbeat: .*/, `heartbeat: "${iso(ms)}"`));
    };
    ok(home, ["active", "claim"], { env: other });
    setHeartbeat(Date.now() - 2 * 3_600_000 + 5000); // eşiğin altında: taze, yazma durur
    expect(fail(home, ["card", "new", "--kind", "ci_red", "--project", "alpha", "--title", "x"]).error).toMatch(/^active_elsewhere/);
    setHeartbeat(Date.now() - 2 * 3_600_000 - 5000); // eşiğin üstünde: bayat, yazma sürer
    ok(home, ["card", "new", "--kind", "ci_red", "--project", "alpha", "--title", "x"]);
  });
  it("records: worker exemption requires running task file (fake env var alone not enough)", async () => {
    const id = ok<any>(home, ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev"]).id;
    ok(home, ["active", "claim"], { env: other });
    // sahte ortam değişkeni, queued görev: muaf değil
    expect(run(home, ["task", "log", id, "x", "--json"], { env: { VLAD_TASK_ID: id } }).code).toBe(1);
    // yok olan görev kimliği: muaf değil
    expect(run(home, ["task", "log", id, "x", "--json"], { env: { VLAD_TASK_ID: "T19990101-01" } }).code).toBe(1);
  });
  it("records: concurrent claim one wins", async () => {
    const rs = await Promise.all(["a", "b", "c", "d"].map((m) => runAsync(home, ["active", "claim", "--json"], { VLAD_MACHINE: m })));
    expect(rs.filter((r) => r.code === 0)).toHaveLength(1);
  });
});
void writeConfig;
