import { closeSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";
import { kbPaths } from "./home.js";

export interface LockOptions {
  /** how long to wait for the lock before giving up (default 10 s, $VLAD_LOCK_WAIT_MS) */
  waitMs?: number;
  /** a lock older than this is taken over (default 60 s, $VLAD_LOCK_STALE_MS) */
  staleMs?: number;
}

const envMs = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** locks this process holds, so a nested withKbLock re-enters instead of deadlocking */
let depth = 0;
let held: { file: string; token: string } | undefined;

function readLock(file: string): { raw: string; pid: number } | undefined {
  try {
    const raw = readFileSync(file, "utf8");
    return { raw, pid: Number(raw.split(/\s/)[0]) };
  } catch {
    return undefined;
  }
}

/** True if the lock file is abandoned: its owner pid is gone, or it was not touched for staleMs. */
function isStale(file: string, staleMs: number): boolean {
  const cur = readLock(file);
  if (!cur) return false; // vanished meanwhile: just retry the O_EXCL create
  if (Number.isInteger(cur.pid) && cur.pid > 0 && !pidAlive(cur.pid)) return true;
  try {
    return Date.now() - statSync(file).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** Removes the lock only if it still holds the content we judged stale (not a fresh owner's). */
function breakStale(file: string): void {
  const before = readLock(file);
  if (!before || readLock(file)?.raw !== before.raw) return;
  try {
    unlinkSync(file);
  } catch { /* someone else broke it first */ }
}

/**
 * Runs fn while holding the kb write lock (`kb/.vlad.lock`, created with O_EXCL, containing
 * `<pid> <random token>`). Waits up to waitMs, then fails with `kb meşgul`. A lock whose owner pid is
 * dead or whose mtime is older than staleMs is taken over. While fn runs the mtime is refreshed, so a
 * long async operation is not mistaken for a stale one. Re-entrant within one process.
 */
export async function withKbLock<T>(fn: () => T | Promise<T>, opts: LockOptions = {}): Promise<T> {
  if (depth > 0) return fn();
  const file = join(kbPaths().kb, ".vlad.lock");
  const waitMs = opts.waitMs ?? envMs("VLAD_LOCK_WAIT_MS", 10_000);
  const staleMs = opts.staleMs ?? envMs("VLAD_LOCK_STALE_MS", 60_000);
  const token = `${process.pid} ${Math.random().toString(36).slice(2)}\n`;
  const deadline = Date.now() + waitMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 50)) {
    try {
      const fd = openSync(file, "wx");
      try { writeSync(fd, token); } finally { closeSync(fd); }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (isStale(file, staleMs)) { breakStale(file); continue; }
    if (Date.now() >= deadline) {
      const owner = readLock(file)?.pid;
      throw new Error(`kb meşgul: ${waitMs / 1000} sn içinde yazma kilidi alınamadı${owner ? ` (pid ${owner})` : ""}`);
    }
    await sleep(delay + Math.random() * delay);
  }
  depth = 1;
  held = { file, token };
  const beat = setInterval(() => {
    try { const now = new Date(); utimesSync(file, now, now); } catch { /* lock gone */ }
  }, Math.max(1000, staleMs / 4));
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    depth = 0;
    held = undefined;
    // delete only our own lock: after a (wrongly judged) takeover the file belongs to someone else
    if (readLock(file)?.raw === token) {
      try { unlinkSync(file); } catch { /* already gone */ }
    }
  }
}

// process.exit() inside a command (fail) must not leave the lock behind
process.on("exit", () => {
  if (held && readLock(held.file)?.raw === held.token) try { unlinkSync(held.file); } catch { /* ignore */ }
});
