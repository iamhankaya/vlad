import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, validate } from "../kb/index.js";
import { safeAppendFile } from "../kb/safefs.js";
import type { AuditData } from "../kb/index.js";

const auditDir = () => join(kbPaths().kb, "audit");
const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

/** Parsed lines in file order; a corrupt or invalid line becomes a warning (`<file>:<line>: <reason>`). */
function readAll(): { entries: AuditData[]; warnings: string[] } {
  const entries: AuditData[] = [];
  const warnings: string[] = [];
  const dir = auditDir();
  if (!existsSync(dir)) return { entries, warnings };
  for (const name of readdirSync(dir).filter((f) => MONTH_FILE.test(f)).sort()) {
    readFileSync(join(dir, name), "utf8").split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const data = JSON.parse(line) as AuditData;
        validate("audit", data);
        entries.push(data);
      } catch (e) {
        warnings.push(`${name}:${i + 1}: ${(e as Error).message}`);
      }
    });
  }
  return { entries, warnings };
}

/**
 * Appends one validated line to `kb/audit/<YYYY-MM>.jsonl` (month of `ts`). `action_id` must not exist in
 * any month. Call inside withKbLock (defWrite does): the duplicate check and the append are one critical section.
 */
export function addAudit(raw: unknown): AuditData {
  validate("audit", raw);
  const data = raw as AuditData;
  if (readAll().entries.some((e) => e.action_id === data.action_id)) {
    throw new Error(`action_id zaten var: ${data.action_id}`);
  }
  mkdirSync(auditDir(), { recursive: true });
  safeAppendFile(join(auditDir(), `${data.ts.slice(0, 7)}.jsonl`), JSON.stringify(data) + "\n");
  return data;
}

/** Valid entries (optionally with `ts` >= since) in month/line order, plus warnings for unreadable lines. */
export function listAudit(f: { since?: string } = {}): { entries: AuditData[]; warnings: string[] } {
  let sinceMs: number | undefined;
  if (f.since !== undefined) {
    sinceMs = Date.parse(f.since);
    if (Number.isNaN(sinceMs)) throw new Error(`geçersiz --since: "${f.since}" (ISO tarih bekleniyor)`);
  }
  const { entries, warnings } = readAll();
  return { entries: sinceMs === undefined ? entries : entries.filter((e) => Date.parse(e.ts) >= sinceMs!), warnings };
}
