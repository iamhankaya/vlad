import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../kb/atomic.js";
import { kbPaths } from "../kb/home.js";
import type { LintCode, LintResult } from "./lint.js";
import { nowIso } from "../kb/time.js";

/** What `vlad status --summary` shows: the last full `kb lint` run. The cache keeps the startup hook cheap: it re-lints (short timeout) only when this file is stale. */
export interface LintSummary {
  /** flags counted for the status line; `summary_stale` is left out (the line already reports stale summaries) */
  count: number;
  byCode: Partial<Record<LintCode, number>>;
  /** ISO time of the lint run; null when there is no cached run yet */
  at: string | null;
  /** kb git HEAD at the lint run (absent in old caches / a kb that is not a git checkout) */
  head?: string | null;
}

/** A cached run older than this is shown with its age (the lint is not rerun by the hook). */
export const LINT_CACHE_FRESH_HOURS = 24;
/** The SessionStart hook re-lints when the cache is older than this or the kb HEAD moved. */
export const LINT_REFRESH_HOURS = 6;
/** Time the hook gives a refreshing lint run; on expiry the old cache is shown as stale. */
export const LINT_REFRESH_TIMEOUT_MS = 10_000;

const cachePath = () => join(kbPaths().logs, "kb-lint.json");

export const emptyLintSummary = (): LintSummary => ({ count: 0, byCode: {}, at: null });

/** Summarizes a lint result for the cache (without `summary_stale`). */
export function summarizeLint(r: LintResult, now: Date = new Date(), head: string | null = null): LintSummary {
  const byCode: Partial<Record<LintCode, number>> = {};
  let count = 0;
  for (const [code, n] of Object.entries(r.counts) as [LintCode, number][]) {
    if (code === "summary_stale") continue;
    byCode[code] = n;
    count += n;
  }
  return { count, byCode, at: nowIso(now), head };
}

/** Stores the summary of a full (whole-kb) lint run in `kb/logs/` (gitignored); best effort, a read-only kb is not an error. */
export function writeLintCache(r: LintResult, now: Date = new Date()): void {
  try {
    mkdirSync(kbPaths().logs, { recursive: true });
    writeFileAtomic(cachePath(), JSON.stringify(summarizeLint(r, now, kbHead())) + "\n");
  } catch { /* cache is an optimisation */ }
}

/** The cached summary, or an empty one (`at: null`) when there is none or it is unreadable. Never lints. */
export function readLintCache(): LintSummary {
  try {
    if (!existsSync(cachePath())) return emptyLintSummary();
    const j = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<LintSummary>;
    if (typeof j.count !== "number" || typeof j.at !== "string") return emptyLintSummary();
    return { count: j.count, byCode: j.byCode ?? {}, at: j.at, head: typeof j.head === "string" ? j.head : null };
  } catch { return emptyLintSummary(); }
}

/** " (lint 2 gün önce)" when the cached run is older than {@link LINT_CACHE_FRESH_HOURS}, else "". */
export function lintAgeNote(s: LintSummary, now: Date = new Date()): string {
  if (!s.at) return "";
  const hours = (now.getTime() - new Date(s.at).getTime()) / 3_600_000;
  if (!(hours > LINT_CACHE_FRESH_HOURS)) return "";
  return ` (lint ${Math.floor(hours / 24)} gün önce)`;
}

/** The kb checkout's git HEAD, or null when the kb is not a git checkout / git is unavailable. */
export function kbHead(): string | null {
  try {
    const r = spawnSync("git", ["-C", kbPaths().kb, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000 });
    const sha = r.status === 0 ? r.stdout.trim() : "";
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
  } catch { return null; }
}

/** True when the cache is missing, older than {@link LINT_REFRESH_HOURS}, or was written for another kb HEAD. */
export function lintCacheStale(s: LintSummary, head: string | null, now: Date = new Date()): boolean {
  if (!s.at) return true;
  const hours = (now.getTime() - new Date(s.at).getTime()) / 3_600_000;
  if (!(hours <= LINT_REFRESH_HOURS)) return true;
  return head !== null && s.head !== head;
}

export interface LintRefreshDeps {
  now?: Date;
  /** runs the whole-kb lint (which rewrites the cache) within `timeoutMs`; `timedOut` also covers a failed run */
  run?: (timeoutMs: number) => { ok: boolean };
  head?: () => string | null;
  /** false on a worker / unknown-identity machine: `kb lint` is rejected there, so the hook must not try it (the CLI passes this; the audit layer cannot import the agent) */
  canRun?: () => boolean;
  timeoutMs?: number;
}

/**
 * SessionStart hook: re-lints the whole kb when the cache is stale, bounded by a short timeout (a lint is well
 * under a second on a normal kb). Returns `stale: true` when the cache is still stale afterwards (timeout/failure),
 * so the caller can show the old numbers as "eski". Never throws.
 */
export function refreshLintCacheIfStale(d: LintRefreshDeps = {}): { refreshed: boolean; stale: boolean } {
  try {
    const now = d.now ?? new Date();
    if (d.canRun && !d.canRun()) return { refreshed: false, stale: true };
    const head = (d.head ?? kbHead)();
    if (!lintCacheStale(readLintCache(), head, now)) return { refreshed: false, stale: false };
    const run = d.run ?? ((timeoutMs) => {
      const r = spawnSync(process.execPath, [process.argv[1], "kb", "lint", "--json"], { timeout: timeoutMs, stdio: "ignore", env: process.env });
      return { ok: r.status === 0 }; // no --strict: a clean run exits 0; anything else (worker rejection, crash, timeout) is not a refresh
    });
    const res = run(d.timeoutMs ?? LINT_REFRESH_TIMEOUT_MS);
    return { refreshed: res.ok, stale: !res.ok || lintCacheStale(readLintCache(), head, now) };
  } catch { return { refreshed: false, stale: true }; }
}
