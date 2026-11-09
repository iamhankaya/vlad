import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, nowIso } from "../kb/index.js";
import { getTask, logTask } from "./store.js";

export interface Denial { tool: string; pattern: string; reason?: string }

/** One line, single spaces: a multi-line value must not forge extra İlerleme entries, and spacing must not split one pattern in two. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const DENY_LINE = /^- \S+ \[İZİN\] ([^:\n]+): (.+?)(?: — (.+))?$/;

/** The İlerleme text (without timestamp) `task deny` writes; the setup audit reads it back with parseDenyLine. */
export function formatDenyLine(d: Denial): string {
  const tool = oneLine(d.tool), pattern = oneLine(d.pattern), reason = oneLine(d.reason ?? "");
  if (!tool) throw new Error("--tool zorunlu (Bash, PowerShell, ...)");
  if (!pattern) throw new Error("--pattern zorunlu (reddedilen komut)");
  return `[İZİN] ${tool}: ${pattern}${reason ? ` — ${reason}` : ""}`;
}

/** Parses a timestamped İlerleme line written by formatDenyLine; null for anything else. Pattern is whitespace-normalized. */
export function parseDenyLine(line: string): Denial | null {
  const m = DENY_LINE.exec(line);
  if (!m) return null;
  return { tool: m[1].trim(), pattern: oneLine(m[2]), ...(m[3] ? { reason: m[3].trim() } : {}) };
}

/**
 * Records a structured permission denial: an `[İZİN]` İlerleme line (what the setup audit counts per task) plus one record
 * in kb/logs/denials.jsonl (flat history across tasks). Validation and the task lookup come before any write.
 */
export function denyTask(id: string, d: Denial): void {
  const line = formatDenyLine(d);
  const t = getTask(id);
  logTask(id, line);
  const dir = kbPaths().logs;
  mkdirSync(dir, { recursive: true });
  const rec = { at: nowIso(), task: id, project: t.data.project, tool: oneLine(d.tool), pattern: oneLine(d.pattern), ...(oneLine(d.reason ?? "") ? { reason: oneLine(d.reason ?? "") } : {}) };
  appendFileSync(join(dir, "denials.jsonl"), JSON.stringify(rec) + "\n");
}
