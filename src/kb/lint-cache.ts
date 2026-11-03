import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { kbPaths } from "./home.js";
import type { LintCode, LintResult } from "./lint.js";
import { nowIso } from "./time.js";

/** What `vlad status --summary` shows: the last full `kb lint` run. Linting the whole kb takes ~75 s, so the startup hook only reads this file. */
export interface LintSummary {
  /** flags counted for the status line; `summary_stale` is left out (the line already reports stale summaries) */
  count: number;
  byCode: Partial<Record<LintCode, number>>;
  /** ISO time of the lint run; null when there is no cached run yet */
  at: string | null;
}

/** A cached run older than this is shown with its age (the lint is not rerun by the hook). */
export const LINT_CACHE_FRESH_HOURS = 24;

const cachePath = () => join(kbPaths().logs, "kb-lint.json");

export const emptyLintSummary = (): LintSummary => ({ count: 0, byCode: {}, at: null });

/** Summarizes a lint result for the cache (without `summary_stale`). */
export function summarizeLint(r: LintResult, now: Date = new Date()): LintSummary {
  const byCode: Partial<Record<LintCode, number>> = {};
  let count = 0;
  for (const [code, n] of Object.entries(r.counts) as [LintCode, number][]) {
    if (code === "summary_stale") continue;
    byCode[code] = n;
    count += n;
  }
  return { count, byCode, at: nowIso(now) };
}

/** Stores the summary of a full (whole-kb) lint run in `kb/logs/` (gitignored); best effort, a read-only kb is not an error. */
export function writeLintCache(r: LintResult, now: Date = new Date()): void {
  try {
    mkdirSync(kbPaths().logs, { recursive: true });
    writeFileAtomic(cachePath(), JSON.stringify(summarizeLint(r, now)) + "\n");
  } catch { /* cache is an optimisation */ }
}

/** The cached summary, or an empty one (`at: null`) when there is none or it is unreadable. Never lints. */
export function readLintCache(): LintSummary {
  try {
    if (!existsSync(cachePath())) return emptyLintSummary();
    const j = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<LintSummary>;
    if (typeof j.count !== "number" || typeof j.at !== "string") return emptyLintSummary();
    return { count: j.count, byCode: j.byCode ?? {}, at: j.at };
  } catch { return emptyLintSummary(); }
}

/** " (lint 2 gün önce)" when the cached run is older than {@link LINT_CACHE_FRESH_HOURS}, else "". */
export function lintAgeNote(s: LintSummary, now: Date = new Date()): string {
  if (!s.at) return "";
  const hours = (now.getTime() - new Date(s.at).getTime()) / 3_600_000;
  if (!(hours > LINT_CACHE_FRESH_HOURS)) return "";
  return ` (lint ${Math.floor(hours / 24)} gün önce)`;
}
