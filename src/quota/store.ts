import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths } from "../kb/home.js";
import { nowIso } from "../kb/time.js";

/** `kb/logs/quota.json` (gitignored): the subscription limit marker (mobile plan §Arayüzler). */
export interface QuotaRecord { limited_until: string; reason: string; at: string }
/** What `readyWithLimit` takes: derived from the record, the function itself reads no file. */
export interface QuotaState { limited: boolean; until?: string }

export const quotaFile = () => join(kbPaths().logs, "quota.json");

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseUntil(s: string): number {
  const ms = ISO.test(s) ? Date.parse(s) : NaN;
  if (Number.isNaN(ms)) throw new Error(`geçersiz --until (ISO 8601 zaman, ör. 2026-10-25T03:00:00+03:00): ${s}`);
  return ms;
}

export function setQuota(until: string, reason: string, now: Date = new Date()): QuotaRecord {
  parseUntil(until);
  if (!reason.trim()) throw new Error("--reason boş olamaz");
  const rec: QuotaRecord = { limited_until: until, reason, at: nowIso(now) };
  mkdirSync(kbPaths().logs, { recursive: true });
  writeFileSync(quotaFile(), JSON.stringify(rec, null, 2) + "\n", "utf8");
  return rec;
}

export function clearQuota(): boolean {
  if (!existsSync(quotaFile())) return false;
  unlinkSync(quotaFile());
  return true;
}

/**
 * Reads the marker. A missing, empty, corrupt or past `limited_until` means "no limit"; a corrupt or
 * empty file also adds a warning. `reason` is informational only: an unknown value does not matter.
 */
export function readQuota(now: number = Date.now()): { quota: QuotaState; record: QuotaRecord | null; warnings: string[] } {
  const none = { quota: { limited: false } as QuotaState, record: null, warnings: [] as string[] };
  const file = quotaFile();
  if (!existsSync(file)) return none;
  const warn = (why: string) => ({ ...none, warnings: [`kota dosyası yok sayıldı (${why}): ${file}`] });
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return warn("okunamadı");
  }
  if (!raw.trim()) return warn("boş");
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return warn("bozuk JSON");
  }
  const r = j as Partial<QuotaRecord> | null;
  if (!r || typeof r !== "object" || typeof r.limited_until !== "string" || !ISO.test(r.limited_until) || Number.isNaN(Date.parse(r.limited_until))) {
    return warn("geçersiz limited_until");
  }
  const record: QuotaRecord = {
    limited_until: r.limited_until,
    reason: typeof r.reason === "string" ? r.reason : "",
    at: typeof r.at === "string" ? r.at : "",
  };
  if (Date.parse(record.limited_until) <= now) return { ...none, record }; // expired: no limit
  return { quota: { limited: true, until: record.limited_until }, record, warnings: [] };
}
