import { describe, expect, it } from "vitest";
import { calcTrigger, isoWeekKey, type DayBucket } from "../../src/monitor/capacity-calc.js";
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
    // pencereler: w0 = d0..7, w1 = d8..14 (boş), w2 = d15..21, w3 = d22..27
    const s = series((d) => (d <= 7 ? { max: 50 } : d <= 14 ? null : d <= 21 ? { max: 70 } : { max: 90 }), 28);
    const r = calc(trig(), { a: s });
    expect(r.weekly).toEqual([90, 70, 50]); // 3 hafta var (boş hafta listede yok)
    expect(r.value7d).toBe(50);
  });
  it("kesintisiz pencere: önceki koşudan (7 gün önce) sonraki zirve value7d'ye girer", () => {
    // önceki pazartesi (d=7) 10:00 zirvesi: eski 7 günlük pencere (d0..6) bunu kaçırırdı
    const s = series((d) => ({ max: d === 7 ? 88 : 10 }), 28);
    const r = calc(trig(), { a: s });
    expect(r.value7d).toBe(88);
    expect(r.weekly.at(-1)).toBe(88);
    expect(r.weekly[r.weekly.length - 2]).toBe(10); // bir önceki pencere d8.. ve zirveyi çift saymaz
  });
  it("eğim: boş hafta sıkıştırılmaz, özgün konum korunur ([40,50,boş,70] → 10/hafta)", () => {
    const s = series((d) => (d <= 7 ? { max: 70 } : d <= 14 ? null : d <= 21 ? { max: 50 } : { max: 40 }), 28);
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

describe("isoWeekKey", () => {
  it("ISO hafta anahtarı (UTC); yıl sınırı", () => {
    expect(isoWeekKey(Date.UTC(2026, 10, 23))).toBe("2026-W48");
    expect(isoWeekKey(Date.UTC(2026, 0, 1))).toBe("2026-W01");
    expect(isoWeekKey(Date.UTC(2027, 0, 1))).toBe("2026-W53");
    expect(isoWeekKey(Date.UTC(2025, 11, 29))).toBe("2026-W01");
  });
});
