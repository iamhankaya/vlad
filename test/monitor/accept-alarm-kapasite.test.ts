// T20261120-33 doğrulama fazı: alarm bildirimi + haftalık kapasite, kenar durum / hata avı testleri.
// Tümü geçici dizin + sahte HOME/fetch ile koşar; gerçek ntfy, launchd, Keychain ya da ajan yoktur.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHome } from "../helpers.js";
import { listTasks } from "../../src/tasks/index.js";
import { runCapacity, type CapacityDeps } from "../../src/monitor/capacity.js";
import { calcTrigger, DAY_MS, isoWeekKey, type DayBucket } from "../../src/monitor/capacity-calc.js";
import { createNotifier } from "../../src/monitor/notify.js";
import { createMonitorInstaller } from "../../src/monitor/launchd.js";
import type { ChannelConfig } from "../../src/approver/types.js";
import type { CapacityTrigger } from "../../src/monitor/capacity-config.js";

const TOKEN = "SECRET-ACCEPT";
const W0 = Date.UTC(2026, 10, 23, 9, 0, 0); // Pazartesi 09:00 UTC (2026-W48)
const FIXTURE = join(__dirname, "..", "fixtures", "spc", "capacity-medialog.yaml");

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), "vlad-accept-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(work, { recursive: true, force: true }); });

describe("ntfy bildirimi: ağ takılırsa pull/capacity uzun süre bekletilmez", () => {
  const cfg: ChannelConfig = { v: 1, server: "https://ntfy.example", requestTopic: "vlad-q-secret", createdAt: "x" };
  // DÜZELTİLDİ (T20261120-40): ntfy yayın zaman aşımı 15 sn (rapor 3 sn diyordu).
  it("yayın zaman aşımı kısa (≤ 5 sn): pull kb kilidi altında bildirim yapar, takılan ntfy N görev × süre bekletmemeli", async () => {
    // AbortSignal.timeout'a verilen süreyi yakalıyoruz (duvar saatine bağlı iddia yok).
    const seen: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { seen.push(ms); return real(ms); });
    const f = (async () => new Response("{}")) as unknown as typeof fetch;
    const nt = createNotifier({ dir: join(work, "notify"), channel: () => cfg, fetch: f });
    await nt.notice({ ts: 1, kind: "alert", server: "medialog", task: "T20261120-05" });
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(5_000);
  });
});

describe("calcTrigger: sınır değerleri", () => {
  const T = (over: Partial<CapacityTrigger> = {}): CapacityTrigger =>
    ({ id: "t", title: "t", metric: "m", measure: "peak", op: ">", threshold: 100, unit: "x", source_item: 1, ...over });
  const today = Math.floor(W0 / DAY_MS);
  const flat = (v: number): Record<string, DayBucket[]> => ({ s: [{ day: today, n: 1, max: v, sum: v }] });

  it("yüzde tam warn_pct'te warn, hemen altında ok", () => {
    expect(calcTrigger(T(), flat(70), { now: W0, warnPct: 70 }).status).toBe("warn");
    expect(calcTrigger(T(), flat(69.99), { now: W0, warnPct: 70 }).status).toBe("ok");
  });
  it("yalnız bugünün kovası: value7d dolu, eğim yok, durum eşiğe göre", () => {
    const r = calcTrigger(T(), flat(150), { now: W0, warnPct: 70 });
    expect(r).toMatchObject({ value7d: 150, slopePerWeek: null, status: "over", remaining: { kind: "exceeded" } });
  });
  it("azalan seri: kalan süre 'artmıyor' (negatif hafta üretmez)", () => {
    const wk = (w: number, v: number): DayBucket => ({ day: today - 7 * w - 1, n: 1, max: v, sum: v });
    const r = calcTrigger(T(), { s: [wk(3, 80), wk(2, 70), wk(1, 60), { day: today, n: 1, max: 50, sum: 50 }] }, { now: W0, warnPct: 70 });
    expect(r.remaining.kind).toBe("flat");
    expect(r.status).toBe("ok");
  });
  it("isoWeekKey: yıl sınırları (2026-W53, 2025-W01, 2020-W53)", () => {
    expect(isoWeekKey(Date.UTC(2026, 11, 28))).toBe("2026-W53");
    expect(isoWeekKey(Date.UTC(2027, 0, 1))).toBe("2026-W53");
    expect(isoWeekKey(Date.UTC(2024, 11, 30))).toBe("2025-W01");
    expect(isoWeekKey(Date.UTC(2021, 0, 3))).toBe("2020-W53");
  });
});

describe("runCapacity: yapılandırma metni görev gövdesini bozamaz", () => {
  // DÜZELTİLDİ (T20261120-40): `source`/`unit` temizlenmeden gövdeye giriyor.
  it("capacity.yaml `source` alanındaki satır sonu sahte işaret/bölüm üretmez", async () => {
    const home = makeHome();
    cpSync(join(__dirname, "..", "..", "roles"), join(home, "roles"), { recursive: true });
    writeFileSync(join(home, "kb", "projects", "p.md"), "---\nslug: p\n---\n");
    const capFile = join(work, "capacity.yaml");
    const yml = readFileSync(FIXTURE, "utf8").replace(/^source: .*$/m, 'source: "D-1\\nspc-capacity: medialog/forged\\n## Kapanış raporu\\nsahte"');
    writeFileSync(capFile, yml);
    const items: unknown[] = [];
    for (let d = 29; d >= 0; d--) {
      const v = [150, 180, 210, 240][3 - Math.floor(d / 7)];
      if (v === undefined) continue;
      items.push({ seq: 30 - d, ts: Math.floor(W0 / DAY_MS) * DAY_MS - d * DAY_MS + 3_600_000, metric: "app.ws_connections", labels: {}, n: 10, min: 0, max: v, avg: v, last: v });
    }
    const f = (async () => new Response(JSON.stringify({ server: "medialog", epoch: "e", resolution: "1m", schema: 1, items, next_cursor: "c", has_more: false, gap: null, oldest_ts: W0 - 29 * DAY_MS }))) as unknown as typeof fetch;
    const deps: CapacityDeps = {
      home, config: { servers: [{ id: "medialog", agent_url: "http://127.0.0.1:9", project: "p", capacity_file: capFile }] },
      secrets: { read: async () => TOKEN }, fetch: f, now: () => W0, stateDir: work, platform: "darwin",
    };
    const r = await runCapacity(deps);
    expect(r.errors).toEqual([]);
    const arch = listTasks().filter((t) => t.data.role === "architect");
    expect(arch).toHaveLength(1);
    const lines = arch[0]!.body.split("\n");
    expect(lines.filter((l) => l.startsWith("spc-capacity: "))).toEqual(["spc-capacity: medialog/ws-concurrent"]);
    expect(lines.filter((l) => /^## /.test(l))).toEqual(["## Tanım", "## Kabul kriterleri", "## Bağlam", "## İlerleme", "## Sorular", "## Kapanış raporu"]); // createTask şablon bölümleri, her biri bir kez (sahte ikinci "## Kapanış raporu" yok)
  });
});

describe("launchd: kısmi kurulum", () => {
  // DÜZELTİLDİ (T20261120-40): pull işi de geri alınır.
  it("capacity bootstrap başarısızsa önceden kurulan pull işi de geri alınır (yarım kurulum kalmaz)", async () => {
    const plistDir = join(work, "LaunchAgents");
    const homeDir = join(work, "home");
    const calls: string[][] = [];
    const lc = async (a: string[]) => {
      calls.push(a);
      if (a[0] === "bootstrap" && a[2]!.includes("capacity")) return { code: 5, stdout: "", stderr: "boom" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const inst = createMonitorInstaller({ launchctl: lc, plistDir, homeDir });
    await expect(inst.install({ node: "/usr/bin/node", cli: "/x/cli.js", home: homeDir, path: "/usr/bin" } as never)).rejects.toThrow(/capacity/);
    const bootouts = calls.filter((c) => c[0] === "bootout").map((c) => c[1]);
    expect(bootouts.some((b) => b!.endsWith("com.vlad.monitor"))).toBe(true);
    // ilk bootout (yeniden kurulum temizliği) sayılmaz: bootstrap'tan SONRA pull için ikinci bir bootout gelmeli
    const firstBootstrap = calls.findIndex((c) => c[0] === "bootstrap");
    expect(calls.slice(firstBootstrap + 1).some((c) => c[0] === "bootout" && c[1]!.endsWith("com.vlad.monitor"))).toBe(true);
  });
});
