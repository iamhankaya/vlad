import { describe, expect, it } from "vitest";
import { calcTrigger, directionPct, isoWeekKey, type DayBucket } from "../../src/monitor/capacity-calc.js";
import type { CapacityTrigger } from "../../src/monitor/capacity-config.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 23, 9, 0, 0); // Pazartesi 09:00 UTC
const today = Math.floor(NOW / DAY);
const trig = (o: Partial<CapacityTrigger> = {}): CapacityTrigger => ({ id: "t", title: "T", metric: "m", measure: "peak", op: ">", threshold: 100, unit: "u", source_item: 1, ...o });
/** `perDay(d)`: d = bugünden kaç gün önce (0 = bugün) → günlük kova ya da null. */
const series = (perDay: (d: number) => { max: number; avg?: number } | null, days = 30): DayBucket[] => {
  const out: DayBucket[] = [];
  for (let d = days - 1; d >= 0; d--) { const v = perDay(d); if (v) out.push({ day: today - d, n: 10, max: v.max, sum: (v.avg ?? v.max) * 10 }); }
  return out;
};
const calc = (t: CapacityTrigger, s: Record<string, DayBucket[]>) => calcTrigger(t, s, { now: NOW, warnPct: 70 });

describe("calcTrigger", () => {
  it("artan seri: 7g/30g zirve, yüzde, eğim ve kalan hafta", () => {
    // haftalık zirveler (eskiden yeniye) 40, 50, 60, 70 → eğim 10/hafta, eşik 100 → 3 hafta
    const s = series((d) => ({ max: [70, 60, 50, 40][Math.floor(d / 7)] ?? 40 }), 28);
    const r = calc(trig(), { a: s });
    expect(r.value7d).toBe(70);
    expect(r.value30d).toBe(70);
    expect(r.pct).toBeCloseTo(70);
    expect(r.weekly).toEqual([40, 50, 60, 70]);
    expect(r.slopePerWeek).toBeCloseTo(10);
    expect(r.remaining).toEqual({ kind: "weeks", weeks: 3 });
    expect(r.status).toBe("warn");
  });
  it("düz seri: artmıyor, ok", () => {
    const r = calc(trig(), { a: series(() => ({ max: 30 }), 28) });
    expect(r.remaining).toEqual({ kind: "flat" });
    expect(r.status).toBe("ok");
    expect(r.pct).toBeCloseTo(30);
  });
  it("3 haftadan az veri: yetersiz veri (durum yine eşiğe göre hesaplanır)", () => {
    const r = calc(trig(), { a: series(() => ({ max: 80 }), 10) });
    expect(r.remaining).toEqual({ kind: "insufficient" });
    expect(r.status).toBe("warn");
  });
  it("eşik üstü: aşıldı + over; '>' operatöründe eşit değer over değil", () => {
    const s = series((d) => ({ max: [130, 110, 90, 80][Math.floor(d / 7)] ?? 80 }), 28);
    const r = calc(trig(), { a: s });
    expect(r.remaining).toEqual({ kind: "exceeded" });
    expect(r.status).toBe("over");
    expect(calc(trig({ threshold: 100 }), { a: series(() => ({ max: 100 }), 28) }).status).toBe("warn");
  });
  it("'>=' operatöründe eşit değer over (db-pool-waiting: eşik 1)", () => {
    const r = calc(trig({ op: ">=", threshold: 1 }), { a: series((d) => ({ max: d === 2 ? 1 : 0 }), 28) });
    expect(r.value7d).toBe(1);
    expect(r.status).toBe("over");
  });
  it("daily_avg_peak: günlük n-ağırlıklı ortalamaların en büyüğü; zirve tek sıçrama sayılmaz", () => {
    const s = series((d) => ({ max: 95, avg: d === 3 ? 65 : 20 }), 28);
    const r = calc(trig({ measure: "daily_avg_peak", threshold: 60 }), { a: s });
    expect(r.value7d).toBe(65);
    expect(r.status).toBe("over");
  });
  it("çok serili eşleşme: seri başına hesaplanır, en büyüğü alınır", () => {
    const r = calc(trig(), { a: series(() => ({ max: 20 }), 28), b: series(() => ({ max: 75 }), 28) });
    expect(r.value7d).toBe(75);
  });
  it("boşluklu veri: eksik günler atlanır, boş hafta eğime girmez", () => {
    // pencereler (tam 7 gün): w0 = d0..6, w1 = d7..13 (boş), w2 = d14..20, w3 = d21..27
    const s = series((d) => (d <= 6 ? { max: 50 } : d <= 13 ? null : d <= 20 ? { max: 70 } : { max: 90 }), 28);
    const r = calc(trig(), { a: s });
    expect(r.weekly).toEqual([90, 70, 50]); // 3 hafta var (boş hafta listede yok)
    expect(r.value7d).toBe(50);
  });
  it("tam 7 günlük bitişik pencere: d6 bu haftaya, d7 bir öncekine girer; çift sayılmaz", () => {
    const s = series((d) => ({ max: d === 7 ? 88 : d === 6 ? 40 : 10 }), 28);
    const r = calc(trig(), { a: s });
    expect(r.value7d).toBe(40);
    expect(r.weekly.at(-1)).toBe(40);
    expect(r.weekly[r.weekly.length - 2]).toBe(88);
  });
  it("eğim: boş hafta sıkıştırılmaz, özgün konum korunur ([40,50,boş,70] → 10/hafta)", () => {
    const s = series((d) => (d <= 6 ? { max: 70 } : d <= 13 ? null : d <= 20 ? { max: 50 } : { max: 40 }), 28);
    const r = calc(trig({ threshold: 200 }), { a: s });
    expect(r.weekly).toEqual([40, 50, 70]);
    expect(r.slopePerWeek).toBeCloseTo(10);
  });
  it("son 7 günde veri yok: durum insufficient, yüzde null", () => {
    const r = calc(trig(), { a: series((d) => (d >= 10 ? { max: 50 } : null), 28) });
    expect(r.value7d).toBeNull();
    expect(r.pct).toBeNull();
    expect(r.status).toBe("insufficient");
  });
  it("hiç seri yok: insufficient", () => {
    expect(calc(trig(), {}).status).toBe("insufficient");
  });
  it("30g zirve 7g'den büyük olabilir", () => {
    const r = calc(trig(), { a: series((d) => ({ max: d === 20 ? 90 : 10 }), 30) });
    expect(r.value7d).toBe(10);
    expect(r.value30d).toBe(90);
  });
});

describe("calcTrigger: op '<' (küçük olan kötü)", () => {
  const lt = (o: Partial<CapacityTrigger> = {}): CapacityTrigger => trig({ op: "<", threshold: 95, measure: "daily_avg_peak", ...o });
  const declining = () => series((d) => ({ max: 100, avg: [97, 98, 99, 99.5][Math.floor(d / 7)] ?? 99.5 }), 28); // eskiden yeniye 99.5, 99, 98, 97

  it("directionPct: '<' yönünde eşik/değer, değer ≤ 0 → null; '>' yönü değişmez", () => {
    expect(directionPct("<", 97, 95)).toBeCloseTo(97.94, 1);
    expect(directionPct("<=", 95, 95)).toBeCloseTo(100);
    expect(directionPct("<", 0, 95)).toBeNull();
    expect(directionPct("<", -3, 95)).toBeNull();
    expect(directionPct(">", 70, 100)).toBeCloseTo(70);
  });
  it("kötü değer günlük ortalamaların EN KÜÇÜĞÜdür; eşiğe %70+ yaklaşan düşen seri warn", () => {
    const r = calc(lt(), { a: declining() });
    expect(r.value7d).toBe(97);
    expect(r.pct).toBeCloseTo(97.94, 1);
    expect(r.slopePerWeek).toBeCloseTo(-0.85, 3);
    expect(r.remaining.kind).toBe("weeks");
    if (r.remaining.kind === "weeks") expect(r.remaining.weeks).toBeCloseTo((97 - 95) / 0.85, 1);
    expect(r.status).toBe("warn");
  });
  it("değer eşiğin altına inince over/exceeded; '<' operatöründe eşit değer over değil, '<=' operatöründe over", () => {
    const r = calc(lt(), { a: series(() => ({ max: 100, avg: 90 }), 28) });
    expect(r.status).toBe("over");
    expect(r.remaining).toEqual({ kind: "exceeded" });
    expect(calc(lt(), { a: series(() => ({ max: 100, avg: 95 }), 28) }).status).not.toBe("over");
    expect(calc(lt({ op: "<=" }), { a: series(() => ({ max: 100, avg: 95 }), 28) }).status).toBe("over");
  });
  it("sabit yüksek değerde (99,5; eğim 0) remaining flat ve warn yok", () => {
    const r = calc(lt(), { a: series(() => ({ max: 100, avg: 99.5 }), 28) });
    expect(r.remaining).toEqual({ kind: "flat" });
    expect(r.status).toBe("ok");
  });
  it("yükselen (iyileşen) seri flat sayılır, warn yok", () => {
    const r = calc(lt(), { a: series((d) => ({ max: 100, avg: [99.5, 98, 97, 96.5][Math.floor(d / 7)] ?? 96.5 }), 28) });
    expect(r.remaining).toEqual({ kind: "flat" });
    expect(r.status).toBe("ok");
  });
  it("peak ölçüsü '<' yönünde kova min'ini kullanır (min yoksa ortalamaya düşer)", () => {
    const withMin: DayBucket[] = Array.from({ length: 28 }, (_, i) => ({ day: today - 27 + i, n: 10, max: 100, sum: 990, min: i === 25 ? 80 : 98 }));
    expect(calc(lt({ measure: "peak" }), { a: withMin }).value7d).toBe(80);
    const noMin: DayBucket[] = Array.from({ length: 28 }, (_, i) => ({ day: today - 27 + i, n: 10, max: 100, sum: 990 }));
    expect(calc(lt({ measure: "peak" }), { a: noMin }).value7d).toBeCloseTo(99);
  });
  it("çok seri: en kötü (en küçük) seri alınır", () => {
    const r = calc(lt(), { a: series(() => ({ max: 100, avg: 99 }), 28), b: series(() => ({ max: 100, avg: 96 }), 28) });
    expect(r.value7d).toBe(96);
  });
  it("veri yok: insufficient, pct null", () => {
    const r = calc(lt(), {});
    expect(r.status).toBe("insufficient");
    expect(r.pct).toBeNull();
  });
});

describe("calcTrigger: kind 'trend' (eşiksiz eğilim)", () => {
  const trend = (): CapacityTrigger => ({ id: "product-active", title: "Aktif kullanıcı", metric: "m", measure: "daily_avg_peak", kind: "trend", unit: "kişi", source_item: 1 });
  it("hiçbir zaman warn/over olmaz; pct null; haftalık değer + eğim verilir", () => {
    const r = calc(trend(), { a: series((d) => ({ max: 0, avg: [31, 29, 26, 23][Math.floor(d / 7)] ?? 23 }), 28) });
    expect(r.weekly).toEqual([23, 26, 29, 31]);
    expect(r.value7d).toBe(31);
    expect(r.slopePerWeek).toBeCloseTo(2.7, 1);
    expect(r.pct).toBeNull();
    expect(r.remaining).toEqual({ kind: "flat" });
    expect(r.status).toBe("ok");
  });
  it("çok büyük/ani artış da warn/over üretmez", () => {
    const r = calc(trend(), { a: series((d) => ({ max: 0, avg: [10000, 100, 10, 1][Math.floor(d / 7)] ?? 1 }), 28) });
    expect(r.status).toBe("ok");
  });
  it("tek hafta veri: insufficient (satır yine yazılabilsin diye değer korunur)", () => {
    const r = calc(trend(), { a: series(() => ({ max: 0, avg: 25 }), 6) });
    expect(r.status).toBe("insufficient");
    expect(r.remaining).toEqual({ kind: "insufficient" });
    expect(r.value7d).toBe(25);
    expect(r.slopePerWeek).toBeNull();
  });
  it("hiç veri: insufficient, değerler null", () => {
    const r = calc(trend(), {});
    expect(r.status).toBe("insufficient");
    expect(r.value7d).toBeNull();
  });
});

describe("isoWeekKey", () => {
  it("ISO hafta anahtarı (UTC); yıl sınırı", () => {
    expect(isoWeekKey(Date.UTC(2026, 10, 23))).toBe("2026-W48");
    expect(isoWeekKey(Date.UTC(2026, 0, 1))).toBe("2026-W01");
    expect(isoWeekKey(Date.UTC(2027, 0, 1))).toBe("2026-W53");
    expect(isoWeekKey(Date.UTC(2025, 11, 29))).toBe("2026-W01");
  });
});
