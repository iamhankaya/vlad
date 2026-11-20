import type { CapacityTrigger } from "./capacity-config.js";

/**
 * Kapasite hesabı (saf işlev; plan Karar 3). Girdi: tetikleyiciye uyan seri başına günlük (UTC) kovalar.
 * Ölçüler: `peak` = kova `max`'ının en büyüğü; `daily_avg_peak` = günlük n-ağırlıklı ortalamaların en büyüğü. Çok seri: seri başına hesapla, en büyüğü al.
 * Haftalık değerler: kesintisiz pencereler; 0 = son 7 tam gün + bugün (8 kova: önceki koşudan bu yana zirve kaçmasın), sonrakiler 7'şer gün ve bitişik;
 * veri olan en çok 4 pencere. Eğim: gözlenen haftaların ÖZGÜN konumunda (boş hafta sıkıştırılmaz) en küçük kareler (birim/hafta).
 */
export const DAY_MS = 86_400_000;
export interface DayBucket { day: number; n: number; max: number; sum: number }

export type Remaining = { kind: "weeks"; weeks: number } | { kind: "flat" } | { kind: "exceeded" } | { kind: "insufficient" };
export type TriggerStatus = "ok" | "warn" | "over" | "insufficient";
export interface TriggerReport {
  id: string;
  value7d: number | null;
  value30d: number | null;
  pct: number | null;
  /** Eskiden yeniye, veri olan pencereler (≤ 4). */
  weekly: number[];
  slopePerWeek: number | null;
  remaining: Remaining;
  status: TriggerStatus;
}

const MIN_WEEKS = 3;
const MAX_WEEKS = 4;

function measure(m: CapacityTrigger["measure"], b: DayBucket): number { return m === "peak" ? b.max : b.sum / b.n; }

/** Seriler arası en büyük; kapsamda hiç kova yoksa null. */
function value(m: CapacityTrigger["measure"], series: DayBucket[][], fromDay: number, toDay: number): number | null {
  let best: number | null = null;
  for (const s of series) for (const b of s) {
    if (b.day < fromDay || b.day > toDay || b.n <= 0) continue;
    const v = measure(m, b);
    if (best === null || v > best) best = v;
  }
  return best;
}

/** (x = hafta konumu, y = değer) noktalarına en küçük kareler eğimi. */
function slope(pts: { x: number; y: number }[]): number {
  const n = pts.length, mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}

export function calcTrigger(t: CapacityTrigger, bySeries: Record<string, DayBucket[]>, o: { now: number; warnPct: number }): TriggerReport {
  const series = Object.values(bySeries);
  const today = Math.floor(o.now / DAY_MS);
  const value7d = value(t.measure, series, today - 7, today);
  const value30d = value(t.measure, series, today - 29, today);
  const weekly: number[] = [];
  const pts: { x: number; y: number }[] = [];
  for (let w = MAX_WEEKS - 1; w >= 0; w--) {
    const v = value(t.measure, series, today - 7 - 7 * w, w === 0 ? today : today - 8 - 7 * (w - 1));
    if (v !== null) { weekly.push(v); pts.push({ x: MAX_WEEKS - 1 - w, y: v }); }
  }
  const pct = value7d === null ? null : (value7d / t.threshold) * 100;
  const over = value7d !== null && (t.op === ">=" ? value7d >= t.threshold : value7d > t.threshold);
  const status: TriggerStatus = value7d === null ? "insufficient" : over ? "over" : pct! >= o.warnPct ? "warn" : "ok";
  const sl = pts.length >= MIN_WEEKS ? slope(pts) : null;
  let remaining: Remaining;
  if (over) remaining = { kind: "exceeded" };
  else if (sl === null || value7d === null) remaining = { kind: "insufficient" };
  else if (sl <= 1e-9) remaining = { kind: "flat" };
  else remaining = { kind: "weeks", weeks: (t.threshold - value7d) / sl };
  return { id: t.id, value7d, value30d, pct, weekly, slopePerWeek: sl, remaining, status };
}

/** ISO 8601 hafta anahtarı (UTC): `YYYY-Www`. */
export function isoWeekKey(ms: number): string {
  const d = new Date(Math.floor(ms / DAY_MS) * DAY_MS);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow); // haftanın perşembesi
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
