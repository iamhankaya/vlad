// T13 kabul (T20261025-90): saat kayması. Kaynak: topoloji notu K8 "Saat kayması", `src/active/store.ts` eşikleri.
// Eşikler tam sınırda (±1 sn) süreç içinde sınanır: `now` enjekte edilebildiğinden saat sahtelenmez ve CI yavaşlığı sonucu bozmaz.
// CLI düzeyinde ayrıca geniş payla (±2 dk) uçtan uca doğrulanır. `clock_skew` uyarısı S13b'dir (kırmızı kalabilir).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVE_STALE_MS, activeGuard, activeStatus, claimActive } from "../../src/active/index.js";
import { makeWorld, iso, type Machine } from "../../server/test/helpers/kbRepos.ts";

const MIN = 60_000, HOUR = 3_600_000;
// tam saniyeye yuvarlı taban: nowIso saniye çözünürlüklü
const T = Math.floor(Date.now() / 1000) * 1000;

let m: Machine;
const saved = { home: process.env.VLAD_HOME, kb: process.env.VLAD_KB_DIR, machine: process.env.VLAD_MACHINE };
beforeEach(() => {
  m = makeWorld().machines.winbox!;
  process.env.VLAD_HOME = m.home;
  process.env.VLAD_KB_DIR = m.kb;
});
afterEach(() => {
  for (const [k, v] of [["VLAD_HOME", saved.home], ["VLAD_KB_DIR", saved.kb], ["VLAD_MACHINE", saved.machine]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

/** Başka makinenin yazdığı active.md; `heartbeat` mutlak ms. */
const writeActive = (machine: string, heartbeatMs: number) =>
  writeFileSync(join(m.kb, "active.md"), `---\nmachine: ${machine}\nsince: ${iso(heartbeatMs)}\nheartbeat: ${iso(heartbeatMs)}\ntakeover_from: null\n---\n\n`);

describe("acceptance: kb topology clock skew", () => {
  it("acceptance: kb topology clock skew writer ahead fresh, writer behind at threshold ±1 s", () => {
    // yazanın saati ileride: yaş negatif, kayıt taze (güvenli taraf), devralma yok, yazma durur
    writeActive("other", T + 3 * HOUR);
    let st = activeStatus({ now: T, machine: "me" });
    expect(st.ageMs).toBeLessThan(0);
    expect(st.stale).toBe(false);
    expect(() => claimActive({ now: T, machine: "me" })).toThrow(/^active_elsewhere/);
    expect(() => activeGuard("full", { now: T, machine: "me" })).toThrow(/^active_elsewhere/);

    // yazanın saati geride: eşiğin 1 sn altı taze
    writeActive("other", T - ACTIVE_STALE_MS + 1000);
    st = activeStatus({ now: T, machine: "me" });
    expect(st.stale).toBe(false);
    expect(() => claimActive({ now: T, machine: "me" })).toThrow(/^active_elsewhere/);

    // tam eşik: bayat (>=)
    writeActive("other", T - ACTIVE_STALE_MS);
    expect(activeStatus({ now: T, machine: "me" }).stale).toBe(true);

    // eşiğin 1 sn üstü: bayat; guard yalnız uyarır, claim uyarıyla devralır
    writeActive("other", T - ACTIVE_STALE_MS - 1000);
    st = activeStatus({ now: T, machine: "me" });
    expect(st.stale).toBe(true);
    const warns = activeGuard("full", { now: T, machine: "me" });
    expect(warns.join("\n")).toMatch(/bayat/);
    const claimed = claimActive({ now: T, machine: "me" });
    expect(claimed.record).toMatchObject({ machine: "me", takeover_from: "other" });
    expect(claimed.warnings.join("\n")).toMatch(/bayat/);
  });

  it("acceptance: kb topology clock skew end to end through the CLI with a 2 minute margin", () => {
    writeActive("other", Date.now() - 2 * HOUR + 2 * MIN); // 1 sa 58 dk önce: taze
    expect(m.fail(["active", "claim"]).error).toMatch(/^active_elsewhere/);
    writeActive("other", Date.now() - 2 * HOUR - 2 * MIN); // 2 sa 2 dk önce: bayat
    const r = m.ok<{ active: { machine: string; takeover_from: string }; warnings: string[] }>(["active", "claim"]);
    expect(r.active).toMatchObject({ machine: "winbox", takeover_from: "other" });
    expect(r.warnings.join("\n")).toMatch(/bayat/);
  });

  it("acceptance: kb topology future heartbeat warns clock_skew", () => {
    const warn = (ahead: number) => {
      writeActive("other", T + ahead);
      return activeStatus({ now: T, machine: "me" }).warnings.filter((x) => x.startsWith("clock_skew"));
    };
    expect(warn(5 * MIN - 1000)).toEqual([]); // 5 dk'dan fazla değil
    expect(warn(5 * MIN)).toEqual([]);
    expect(warn(5 * MIN + 1000)).toHaveLength(1);
    expect(warn(3 * HOUR)).toHaveLength(1);
    // geride olan kayıt (bayat ya da değil) kayma uyarısı vermez
    writeActive("other", T - 30 * MIN);
    expect(activeStatus({ now: T, machine: "me" }).warnings).toEqual([]);

    // CLI: uyarı gösterilir, kayıt yine de taze sayılır (devralma yok)
    writeActive("other", Date.now() + 30 * MIN);
    const show = m.ok<{ stale: boolean; warnings: string[] }>(["active", "show"]);
    expect(show.stale).toBe(false);
    expect(show.warnings.some((x) => x.startsWith("clock_skew"))).toBe(true);
    expect(m.fail(["active", "claim"]).error).toMatch(/^active_elsewhere/);
  });
});
