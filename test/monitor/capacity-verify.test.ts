import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { listTasks } from "../../src/tasks/index.js";
import { runCapacity, type CapacityDeps } from "../../src/monitor/capacity.js";
import { calcTrigger, directionPct, type DayBucket } from "../../src/monitor/capacity-calc.js";
import { loadCapacityConfig, CapacityConfigError, type CapacityTrigger } from "../../src/monitor/capacity-config.js";

/**
 * T20261120-76 (tester): spc 1.1.0 D doğrulaması. Geliştirici testlerinin dışında kalan sınır/yön/ayrışma senaryoları.
 * Hepsi sahte veri + geçici dizin; gerçek ajan, Keychain ve kb'ye dokunmaz (makeHome geçici VLAD_HOME).
 */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 23, 9, 0, 0);
const today = Math.floor(NOW / DAY);
const trig = (o: Partial<CapacityTrigger> = {}): CapacityTrigger =>
  ({ id: "t", title: "T", metric: "m", measure: "daily_avg_peak", op: "<", threshold: 95, unit: "%", source_item: 1, ...o }) as CapacityTrigger;
/** perWeek: eskiden yeniye 4 hafta; her gün aynı değer (avg = max = min). */
const weeks = (vals: number[], extra: Partial<DayBucket> = {}): DayBucket[] => {
  const out: DayBucket[] = [];
  for (let d = vals.length * 7 - 1; d >= 0; d--) {
    const v = vals[vals.length - 1 - Math.floor(d / 7)]!;
    out.push({ day: today - d, n: 10, max: v, sum: v * 10, ...extra });
  }
  return out;
};
const calc = (t: CapacityTrigger, s: Record<string, DayBucket[]>) => calcTrigger(t, s, { now: NOW, warnPct: 70 });

describe("`<` yönü: sınırlar", () => {
  it("değer tam eşikte: `<` over değil, `<=` over", () => {
    expect(calc(trig({ op: "<" }), { a: weeks([95, 95, 95, 95]) }).status).not.toBe("over");
    expect(calc(trig({ op: "<=" }), { a: weeks([95, 95, 95, 95]) }).status).toBe("over");
  });
  it("değer eşiğin altına düşünce over; kalan süre 'exceeded'", () => {
    const r = calc(trig(), { a: weeks([97, 96, 95, 94]) });
    expect(r.status).toBe("over");
    expect(r.remaining).toEqual({ kind: "exceeded" });
  });
  it("kalan süre formülü: 98 → eşik 95, eğim -1/hafta → 3 hafta", () => {
    const r = calc(trig(), { a: weeks([101, 100, 99, 98]) });
    expect(r.slopePerWeek).toBeCloseTo(-1);
    expect(r.remaining.kind).toBe("weeks");
    if (r.remaining.kind === "weeks") expect(r.remaining.weeks).toBeCloseTo(3);
  });
  it("değer 0 ve negatif: pct null, over (çökme yok)", () => {
    for (const v of [0, -5]) {
      const r = calc(trig(), { a: weeks([v, v, v, v]) });
      expect(r.pct).toBeNull();
      expect(r.status).toBe("over");
    }
    expect(directionPct("<", 0, 95)).toBeNull();
  });
  it("çok seri: `<` yönünde en KÜÇÜK seri değeri kazanır (en büyük değil)", () => {
    const r = calc(trig(), { good: weeks([99, 99, 99, 99]), bad: weeks([90, 90, 90, 90]) });
    expect(r.value7d).toBe(90);
    expect(r.status).toBe("over");
  });
  it("daily_avg_peak + `<`: günlük ortalamaların en küçüğü (kova min'i değil)", () => {
    // her kovada max 100, ortalama 96, min 10: ortalama ölçülmeli
    const s = weeks([96, 96, 96, 96]).map((b) => ({ ...b, max: 100, min: 10 }));
    expect(calc(trig({ measure: "daily_avg_peak" }), { a: s }).value7d).toBe(96);
  });
  it("peak + `<`: kovanın min'i; min yoksa ortalamaya düşer", () => {
    const withMin = weeks([96, 96, 96, 96]).map((b) => ({ ...b, min: 80 }));
    expect(calc(trig({ measure: "peak", threshold: 85 }), { a: withMin }).status).toBe("over");
    expect(calc(trig({ measure: "peak", threshold: 85 }), { a: weeks([96, 96, 96, 96]) }).value7d).toBe(96);
  });
  it("`>` yönü eskisi gibi: düşen seri warn olmaz, yükselen seri weeks verir (regresyon)", () => {
    const up = calc(trig({ op: ">", threshold: 100, measure: "peak" }), { a: weeks([40, 50, 60, 70]) });
    expect(up.status).toBe("warn");
    expect(up.remaining).toEqual({ kind: "weeks", weeks: 3 });
    expect(calc(trig({ op: ">", threshold: 100, measure: "peak" }), { a: weeks([70, 60, 50, 40]) }).remaining).toEqual({ kind: "flat" });
  });
  // BİLİNEN HATA (rapor: ### Bulunan hatalar #1): `<` yönünde pct = eşik/değer, yüzde türü metriklerde (≤100) hep ≥ %95 > warn_pct olduğundan
  // uyarıyı yalnız "eğim < -1e-9" belirler; 99,90→99,87 (haftada -0,01 puan, eşiğe 487 hafta) gürültüsü warn → architect görevi açar.
  // `it.fails`: bug giderilince bu test yeşile döner ve vitest "beklenen hata yok" diye kırmızılaşır → `it.fails`'i `it` yap.
  it.fails("`<` yönünde yalnız anlamsız düzeyde (haftada -0,01 puan) düşen, eşikten çok uzak seri warn olmamalı", () => {
    expect(calc(trig(), { a: weeks([99.9, 99.89, 99.88, 99.87]) }).status).toBe("ok");
  });
  it("yükselen `<` serisi (iyileşiyor): warn yok, flat", () => {
    const r = calc(trig(), { a: weeks([96, 97, 98, 99]) });
    expect(r.status).toBe("ok");
    expect(r.remaining).toEqual({ kind: "flat" });
  });
});

describe("kind: trend — hesap", () => {
  const tr = (o: Partial<CapacityTrigger> = {}) => trig({ kind: "trend", op: undefined, threshold: undefined, unit: "kişi", ...o });
  it("en az 3 hafta: ok + eğim; düşen seride de ok (asla warn/over)", () => {
    const up = calc(tr(), { a: weeks([20, 24, 28, 32]) });
    expect(up).toMatchObject({ status: "ok", pct: null });
    expect(up.slopePerWeek).toBeCloseTo(4);
    for (const vals of [[32, 28, 24, 20], [0, 0, 0, 0], [1e9, 1e9, 1e9, 1e9]]) {
      const r = calc(tr(), { a: weeks(vals) });
      expect(["ok"]).toContain(r.status);
      expect(r.pct).toBeNull();
    }
  });
  it("2 hafta veri: insufficient, değer ve haftalıklar korunur", () => {
    const r = calc(tr(), { a: weeks([20, 24]) });
    expect(r.status).toBe("insufficient");
    expect(r.value7d).toBe(24);
    expect(r.weekly).toEqual([20, 24]);
  });
  it("veri hiç yok: insufficient, değer null", () => {
    const r = calc(tr(), { a: [] });
    expect(r).toMatchObject({ status: "insufficient", value7d: null, weekly: [] });
  });
});

describe("config doğrulaması (şema kopyası)", () => {
  let dir: string;
  beforeEach(() => { makeHome(); dir = mkdtempSync(join(tmpdir(), "vlad-capv-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const load = (trigger: string) => {
    const f = join(dir, "c.yaml");
    writeFileSync(f, `version: 1\nserver: medialog\nsource: x\nwarn_pct: 70\nconsecutive_weeks: 2\ntriggers:\n  - id: t\n    title: T\n    metric: a.b\n    measure: peak\n    unit: u\n    source_item: 1\n${trigger}`);
    return loadCapacityConfig(f, { schemaDir: join(__dirname, "..", "..", "schemas") });
  };
  it("eşikli tetikleyici op/threshold olmadan reddedilir", () => {
    expect(() => load("")).toThrow(CapacityConfigError);
    expect(() => load("    op: '<'\n")).toThrow(CapacityConfigError);
    expect(() => load("    threshold: 5\n")).toThrow(CapacityConfigError);
  });
  it("trend yalnız op ve threshold'suz; `<=` ve açık `kind: threshold` geçerli", () => {
    expect(load("    kind: trend\n").triggers[0]!.kind).toBe("trend");
    expect(() => load("    kind: trend\n    op: '>'\n")).toThrow(CapacityConfigError);
    expect(() => load("    kind: trend\n    threshold: 3\n")).toThrow(CapacityConfigError);
    expect(load("    kind: threshold\n    op: '<='\n    threshold: 5\n").triggers[0]).toMatchObject({ op: "<=", threshold: 5 });
    expect(() => load("    op: '=='\n    threshold: 5\n")).toThrow(CapacityConfigError);
    expect(() => load("    kind: wat\n    op: '<'\n    threshold: 5\n")).toThrow(CapacityConfigError);
  });
  it("eşik 0 ve negatif reddedilir (exclusiveMinimum)", () => {
    expect(() => load("    op: '<'\n    threshold: 0\n")).toThrow(CapacityConfigError);
    expect(() => load("    op: '<'\n    threshold: -1\n")).toThrow(CapacityConfigError);
  });
});

describe("runCapacity: `<` over bildirimi, trend sessizliği, rapor biçimi", () => {
  let stateDir: string, capFile: string;
  const TOKEN = "SECRET-VERIFY";
  beforeEach(() => {
    const home = makeHome();
    cpSync(join(__dirname, "..", "..", "roles"), join(home, "roles"), { recursive: true });
    writeFileSync(join(home, "kb", "projects", "p.md"), "---\nslug: p\n---\n");
    stateDir = mkdtempSync(join(tmpdir(), "vlad-capv-"));
    capFile = join(stateDir, "capacity.yaml");
    cpSync(join(__dirname, "..", "fixtures", "spc", "capacity-medialog.yaml"), capFile);
  });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  function deps(gen: Record<string, (d: number) => number>, notices: unknown[]): CapacityDeps {
    const f = (async () => {
      const items: unknown[] = []; let seq = 1;
      for (const [metric, fn] of Object.entries(gen)) for (let d = 29; d >= 0; d--) {
        const v = fn(d);
        items.push({ seq: seq++, ts: today * DAY - d * DAY + 3_600_000, metric, labels: {}, n: 10, min: v, max: v, avg: v, last: v });
      }
      return new Response(JSON.stringify({ server: "medialog", epoch: "e", resolution: "1m", schema: 1, items, next_cursor: "c", has_more: false, gap: null, oldest_ts: NOW - 29 * DAY }), { status: 200 });
    }) as unknown as typeof fetch;
    return {
      home: process.env.VLAD_HOME!,
      config: { servers: [{ id: "medialog", agent_url: "http://127.0.0.1:9", project: "p", capacity_file: capFile }] },
      secrets: { read: async () => TOKEN }, fetch: f, now: () => NOW, stateDir, platform: "darwin",
      notifier: { notice: async (n) => { notices.push(n); } },
    };
  }
  const reportBody = () => listTasks().find((t) => t.data.title === "[spc] kapasite raporu: medialog")!.body;

  it("pg.cache_hit_pct eşiğin altına düşünce: over, architect görevi 'en düşük' anlatımıyla, bildirim", async () => {
    const notices: unknown[] = [];
    const r = await runCapacity(deps({ "pg.cache_hit_pct": () => 90 }, notices));
    expect(r.errors).toEqual([]);
    const a = listTasks().filter((t) => t.data.role === "architect");
    expect(a).toHaveLength(1);
    expect(a[0]!.data.title).toContain("pg-cache");
    expect(a[0]!.body).toContain("en düşüğü");
    expect(a[0]!.body).toContain("< 95");
    expect(notices).toHaveLength(1);
    expect(reportBody()).toMatch(/\| pg-cache \| 90 % \| 90 % \| < 95 % \| %105\.6 \|/);
  });
  it("düşen ürün serisi: eğim '-4/hafta', durum 'eğilim'", async () => {
    const notices: unknown[] = [];
    await runCapacity(deps({ "app.product_active_7d": (d) => 20 + 4 * Math.floor(d / 7) }, notices));
    expect(reportBody()).toMatch(/\| product-active \| Ürün büyümesi \(7 gün aktif kullanıcı\) \| \d+ → \d+ kişi \| -4\/hafta \| eğilim \|/);
    expect(notices).toEqual([]);
  });
  it("1.0 ajanı (hiç yeni metrik yok): http-5xx ve tmdb-p95 'veri yok (ajan 1.1 gerekli)'; ana tabloda tetikleyici başına satır yine var", async () => {
    await runCapacity(deps({ "app.ws_connections": () => 10 }, []));
    const body = reportBody();
    const growth = body.split("Hata oranı ve ürün büyümesi")[1]!;
    for (const id of ["http-5xx", "tmdb-p95", "product-active"]) expect(growth).toMatch(new RegExp(`\\| ${id} \\|[^\\n]*veri yok \\(ajan 1\\.1 gerekli\\)`));
    expect(body.split("Hata oranı ve ürün büyümesi")[0]).toContain("| pg-cache |");
  });
  it("aynı hafta --force yeniden koşusu `<` over sayacını ilerletmez", async () => {
    const notices: unknown[] = [];
    const d = deps({ "pg.cache_hit_pct": () => 90 }, notices);
    await runCapacity(d);
    await runCapacity(d, { force: true });
    await runCapacity(d, { force: true });
    expect(listTasks().filter((t) => t.data.role === "architect")).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });
});
