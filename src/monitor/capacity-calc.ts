import { isTrend, lowerIsWorse, type CapacityOp, type CapacityTrigger, type ThresholdTrigger } from "./capacity-config.js";

/**
 * Kapasite hesabı (saf işlev; plan Karar 3). Girdi: tetikleyiciye uyan seri başına günlük (UTC) kovalar.
 * Ölçüler: `peak` = kova `max`'ının en büyüğü; `daily_avg_peak` = günlük n-ağırlıklı ortalamaların en büyüğü. Çok seri: seri başına hesapla, en büyüğü al.
 * Haftalık değerler: kesintisiz pencereler; 0 = son 7 tam gün + bugün (8 kova: önceki koşudan bu yana zirve kaçmasın), sonrakiler 7'şer gün ve bitişik;
 * veri olan en çok 4 pencere. Eğim: gözlenen haftaların ÖZGÜN konumunda (boş hafta sıkıştırılmaz) en küçük kareler (birim/hafta).
 */
export const DAY_MS = 86_400_000;
/** `min` = ajanın dakikalık `min`inin günlük en küçüğü; yoksa (eski fixture/ajan) `peak` + `<` ortalamaya düşer. */
export interface DayBucket { day: number; n: number; max: number; sum: number; min?: number }

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
const SLOPE_EPS = 1e-9;

/** Eşik yönüne göre eşiğe yaklaşma yüzdesi: `>`/`>=` değer/eşik; `<`/`<=` eşik/değer (değer eşiğe indikçe 100'e yaklaşır; değer ≤ 0 → null). */
export function directionPct(op: CapacityOp, value: number, threshold: number): number | null {
  if (op === "<" || op === "<=") return value <= 0 ? null : (threshold / value) * 100;
  return (value / threshold) * 100;
}

/** Kovanın ölçü değeri; `low` (`<` yönü): `peak` → kova min'i (yoksa ortalama), `daily_avg_peak` → ortalama. */
function measure(m: CapacityTrigger["measure"], b: DayBucket, low: boolean): number {
  if (m === "daily_avg_peak") return b.sum / b.n;
  return low ? (b.min ?? b.sum / b.n) : b.max;
}

/** Seriler arası en kötü uç (`low` ise en küçük, değilse en büyük); kapsamda hiç kova yoksa null. */
function value(m: CapacityTrigger["measure"], series: DayBucket[][], fromDay: number, toDay: number, low: boolean): number | null {
  let best: number | null = null;
  for (const s of series) for (const b of s) {
    if (b.day < fromDay || b.day > toDay || b.n <= 0) continue;
    const v = measure(m, b, low);
    if (best === null || (low ? v < best : v > best)) best = v;
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
  const low = lowerIsWorse(t);
  const value7d = value(t.measure, series, today - 7, today, low);
  const value30d = value(t.measure, series, today - 29, today, low);
  const weekly: number[] = [];
  const pts: { x: number; y: number }[] = [];
  for (let w = MAX_WEEKS - 1; w >= 0; w--) {
    const v = value(t.measure, series, today - 7 - 7 * w, w === 0 ? today : today - 8 - 7 * (w - 1), low);
    if (v !== null) { weekly.push(v); pts.push({ x: MAX_WEEKS - 1 - w, y: v }); }
  }
  const sl = pts.length >= MIN_WEEKS ? slope(pts) : null;
  // eğilim tetikleyicisi: eşik/yüzde/kalan süre yok, asla warn/over olmaz; en az 3 haftalık veri yoksa insufficient
  if (isTrend(t)) {
    const ok = value7d !== null && sl !== null;
    return { id: t.id, value7d, value30d, pct: null, weekly, slopePerWeek: sl, remaining: { kind: ok ? "flat" : "insufficient" }, status: ok ? "ok" : "insufficient" };
  }
  return thresholdReport(t, { value7d, value30d, weekly, sl }, o.warnPct);
}

function thresholdReport(t: ThresholdTrigger, v: { value7d: number | null; value30d: number | null; weekly: number[]; sl: number | null }, warnPct: number): TriggerReport {
  const { value7d, sl } = v;
  const low = lowerIsWorse(t);
  const pct = value7d === null ? null : directionPct(t.op, value7d, t.threshold);
  const over = value7d !== null && (t.op === ">=" ? value7d >= t.threshold : t.op === "<=" ? value7d <= t.threshold : t.op === "<" ? value7d < t.threshold : value7d > t.threshold);
  // `<` yönünde eğim kötüleşmiyorsa (sabit/yükselen; ör. önbellek isabeti 99,5'te düz) yaklaşma yüzdesi tek başına uyarı değildir: oran hep yüksektir
  const worsening = sl === null || (low ? sl < -SLOPE_EPS : sl > SLOPE_EPS);
  const status: TriggerStatus = value7d === null ? "insufficient" : over ? "over" : pct !== null && pct >= warnPct && (!low || worsening) ? "warn" : "ok";
  let remaining: Remaining;
  if (over) remaining = { kind: "exceeded" };
  else if (sl === null || value7d === null) remaining = { kind: "insufficient" };
  else if (low ? sl >= -SLOPE_EPS : sl <= SLOPE_EPS) remaining = { kind: "flat" };
  else remaining = { kind: "weeks", weeks: low ? (value7d - t.threshold) / -sl : (t.threshold - value7d) / sl };
  return { id: t.id, value7d, value30d: v.value30d, pct, weekly: v.weekly, slopePerWeek: sl, remaining, status };
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
