import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleepMs, writeFileAtomic } from "./atomic.js";
import { kbPaths } from "./home.js";

const TIMEOUT_MS = 30_000;
const STALE_MS = 10 * 60_000;
const GUARD_STALE_MS = 5_000;
const envMs = (name: string, dflt: number) => { const n = Number(process.env[name]); return process.env[name] !== undefined && Number.isFinite(n) ? n : dflt; };

/** Thrown when the lock could not be taken in time (callers may degrade instead of failing). */
export class KbLockTimeout extends Error {}

let depth = 0; // >0: this process already holds the lock (re-entry must not wait for itself)

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
};

/** Stale = owner process is gone, or the lock is older than `staleMs` (a hung owner). Unparsable content falls back to the file's mtime. */
function isStale(file: string, raw: string, staleMs: number): boolean {
  let pid: number | undefined, started: number | undefined;
  try { ({ pid, started } = JSON.parse(raw) as { pid?: number; started?: number }); } catch { /* fall through to mtime */ }
  if (Number.isInteger(pid) && pid! > 0 && !alive(pid!)) return true;
  if (typeof started !== "number") { try { started = statSync(file).mtimeMs; } catch { return false; } }
  return Date.now() - started >= staleMs;
}

/**
 * Removes a stale lock without the read–unlink race (F-vlad-051): one breaker at a time (O_EXCL guard),
 * re-read under the guard, and rename to a unique name (never unlink the path someone else may recreate).
 * shortcut: a live owner that outlives staleMs and releases in the same microseconds as the break is not covered.
 */
function breakStale(file: string, raw: string, staleMs: number): boolean {
  const guard = `${file}.break`;
  try { writeFileSync(guard, "", { flag: "wx" }); } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
    try { if (Date.now() - statSync(guard).mtimeMs >= GUARD_STALE_MS) rmSync(guard, { force: true }); } catch { /* gone already */ }
    return false; // another breaker holds the guard: the caller must still honor its deadline and back off (F-vlad-106)
  }
  try {
    if (readFileSync(file, "utf8") !== raw || !isStale(file, raw, staleMs)) return true; // changed hands meanwhile
    const trash = `${file}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    renameSync(file, trash);
    rmSync(trash, { force: true });
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  } finally {
    rmSync(guard, { force: true });
  }
  return true;
}

function acquire(file: string, timeoutMs: number, staleMs: number): () => void {
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const content = JSON.stringify({ pid: process.pid, started: Date.now(), token });
  const start = Date.now();
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      writeFileAtomic(file, content, { exclusive: true }); // appears complete or not at all
      return () => {
        try { if ((JSON.parse(readFileSync(file, "utf8")) as { token?: string }).token === token) rmSync(file, { force: true }); } catch { /* broken by someone else, or gone */ }
      };
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { continue; } // released between attempts
    if (isStale(file, raw, staleMs) && breakStale(file, raw, staleMs)) continue;
    if (Date.now() - start >= timeoutMs) {
      let who = "";
      try { const o = JSON.parse(raw) as { pid?: number; started?: number }; who = `; sahip pid ${o.pid}, ${Math.round((Date.now() - (o.started ?? start)) / 1000)} sn önce başladı`; } catch { /* unreadable owner */ }
      throw new KbLockTimeout(`kb kilidi alınamadı (${Math.round(timeoutMs / 1000)} sn beklendi${who}): ${file}`);
    }
    sleepMs(delay + Math.floor(Math.random() * delay));
  }
}

/**
 * Runs `fn` while holding the cross-process kb write lock `<kbDir>/.vlad.lock` (F-vlad-096).
 * Re-entrant within the process. Without a kb directory it runs unlocked (the command fails on its own).
 * shortcut: no heartbeat; a legitimate holder older than staleMs (default 10 min) is treated as hung.
 */
export async function withKbLock<T>(fn: () => T | Promise<T>, o: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const dir = kbPaths().kb;
  if (depth > 0 || !existsSync(dir)) return fn();
  const release = acquire(join(dir, ".vlad.lock"), o.timeoutMs ?? envMs("VLAD_LOCK_TIMEOUT_MS", TIMEOUT_MS), o.staleMs ?? envMs("VLAD_LOCK_STALE_MS", STALE_MS));
  depth++;
  try { return await fn(); } finally { depth--; release(); }
}
