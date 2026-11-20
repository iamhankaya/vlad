import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Kapasite işinin makineye yerel durumu (monitor durum dizinindeki `capacity.json`, dizin 0700, dosya 0600, atomik; sır yok). Plan Karar 3:
 * ISO hafta idempotansı (`last_week`), sunucu başına rapor görevi, tetikleyici başına architect görevi ve ardışık `over` haftaları.
 * Kb yazmalarından SONRA kaydedilir (at-least-once; görev tekrarını işaret taraması önler).
 */
export interface CapacityTriggerState { architect_task: string | null; over_weeks: string[] }
export interface CapacityServerState { last_week: string | null; report_task: string | null; triggers: Record<string, CapacityTriggerState> }
export interface CapacityState { v: 1; servers: Record<string, CapacityServerState> }

export const capacityStatePath = (dir: string): string => join(dir, "capacity.json");
export const emptyCapacityServer = (): CapacityServerState => ({ last_week: null, report_task: null, triggers: {} });

export function loadCapacityState(dir: string): CapacityState {
  const file = capacityStatePath(dir);
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, servers: {} };
    throw e;
  }
  let s: unknown;
  try { s = JSON.parse(raw); } catch { throw new Error(`kapasite durum dosyası bozuk: ${file} (elle silmeden önce inceleyin)`); }
  const o = s as { v?: unknown; servers?: unknown } | null;
  if (!o || typeof o !== "object" || o.v !== 1 || typeof o.servers !== "object" || o.servers === null) throw new Error(`kapasite durum dosyası geçersiz sürüm/şekil: ${file}`);
  return s as CapacityState;
}

export function saveCapacityState(dir: string, s: CapacityState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = capacityStatePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
