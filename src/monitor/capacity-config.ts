import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { parse } from "yaml";
import { getVladHome } from "../kb/index.js";

/**
 * spc `capacity.yaml` (haftalık kapasite raporunun tetikleyici tanımı; plan Karar 3). Şema `schemas/capacity.schema.json` (spc'den vendor).
 * Ek doğrulama: tetikleyici/manuel kimlik tekilliği. Hata `CapacityConfigError` (sunucu kapasite işinden atlanır, `config` uyarısı).
 */
export type CapacityMeasure = "peak" | "daily_avg_peak";
export interface CapacityTrigger {
  id: string; title: string; metric: string; labels?: Record<string, string>;
  measure: CapacityMeasure; op: ">" | ">="; threshold: number; unit: string; source_item: string;
}
export interface CapacityConfig {
  version: 1; server: string; source: string; warn_pct: number; consecutive_weeks: number;
  triggers: CapacityTrigger[]; manual?: { id: string; title: string; source_item: string }[];
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
  const seen = new Set<string>();
  for (const id of [...c.triggers.map((t) => t.id), ...(c.manual ?? []).map((m) => m.id)]) {
    if (seen.has(id)) throw new CapacityConfigError(`capacity.yaml: yinelenen kimlik: ${id}`);
    seen.add(id);
  }
  return c;
}
