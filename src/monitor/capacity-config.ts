import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { parse } from "yaml";
import { getVladHome } from "../kb/index.js";
import { clean } from "./task-text.js";

/**
 * spc `capacity.yaml` (haftalık kapasite raporunun tetikleyici tanımı; plan Karar 3). Şema `schemas/capacity.schema.json` (spc'den vendor).
 * Ek doğrulama: tetikleyici/manuel kimlik tekilliği. Hata `CapacityConfigError` (sunucu kapasite işinden atlanır, `config` uyarısı).
 */
export type CapacityMeasure = "peak" | "daily_avg_peak";
export type CapacityOp = ">" | ">=" | "<" | "<=";
interface TriggerBase { id: string; title: string; metric: string; labels?: Record<string, string>; measure: CapacityMeasure; unit: string; source_item: number }
/** Eşik tetikleyicisi (varsayılan `kind`). `<`/`<=`: küçük olan kötü (ör. önbellek isabet yüzdesi). */
export interface ThresholdTrigger extends TriggerBase { kind?: "threshold"; op: CapacityOp; threshold: number }
/** Eşiksiz eğilim tetikleyicisi (ürün büyümesi): `op`/`threshold` yok (şema reddeder); yalnız raporlanır, görev açmaz. */
export interface TrendTrigger extends TriggerBase { kind: "trend"; op?: undefined; threshold?: undefined }
export type CapacityTrigger = ThresholdTrigger | TrendTrigger;
export const isTrend = (t: CapacityTrigger): t is TrendTrigger => t.kind === "trend";
/** `<`/`<=`: değer eşiğe indikçe kötüleşir. */
export const lowerIsWorse = (t: CapacityTrigger): boolean => t.op === "<" || t.op === "<=";
export interface CapacityConfig {
  version: 1; server: string; source: string; warn_pct: number; consecutive_weeks: number;
  triggers: CapacityTrigger[]; manual?: { id: string; title: string; source_item: number }[];
}


export class CapacityConfigError extends Error {
  constructor(message: string) { super(message); this.name = "CapacityConfigError"; }
}

let cached: { file: string; fn: ValidateFunction } | null = null;
function validator(schemaDir: string): ValidateFunction {
  const file = join(schemaDir, "capacity.schema.json");
  if (cached?.file === file) return cached.fn;
  const fn = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(file, "utf8")));
  cached = { file, fn };
  return fn;
}

export function loadCapacityConfig(file: string, o: { schemaDir?: string } = {}): CapacityConfig {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch (e) { throw new CapacityConfigError(`capacity.yaml okunamadı: ${(e as NodeJS.ErrnoException).code ?? "hata"} (${file})`); }
  let doc: unknown;
  try { doc = parse(raw); } catch { throw new CapacityConfigError(`capacity.yaml bozuk YAML: ${file}`); }
  const fn = validator(o.schemaDir ?? join(getVladHome(), "schemas"));
  if (!fn(doc)) {
    throw new CapacityConfigError(`capacity.yaml geçersiz: ${(fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ")}`);
  }
  const c = doc as CapacityConfig;
  // serbest metin alanları görev gövdesine girer: kontrol karakteri/satır sonu boşluk olur (sahte işaret/bölüm üretemez)
  c.source = clean(c.source);
  for (const t of c.triggers) { t.title = clean(t.title); t.unit = clean(t.unit); }
  for (const m of c.manual ?? []) m.title = clean(m.title);
  const seen = new Set<string>();
  for (const id of [...c.triggers.map((t) => t.id), ...(c.manual ?? []).map((m) => m.id)]) {
    if (seen.has(id)) throw new CapacityConfigError(`capacity.yaml: yinelenen kimlik: ${id}`);
    seen.add(id);
  }
  return c;
}
