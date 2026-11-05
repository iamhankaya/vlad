import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.claude.json`; VLAD_CLAUDE_JSON overrides it (tests must never touch the real file). */
export const claudeJsonPath = (): string => process.env.VLAD_CLAUDE_JSON || join(homedir(), ".claude.json");

/** Claude Code keys `projects` by the path with forward slashes. */
export const trustKey = (dir: string): string => dir.replaceAll("\\", "/");

type Json = { projects?: Record<string, Record<string, unknown>> } & Record<string, unknown>;

export interface TrustOpts {
  /** how long to wait for the lock before giving up with a warning (default 5000 ms) */ lockWaitMs?: number;
  /** test injection: is this pid a live process (default: signal 0) */ isAlive?: (pid: number) => boolean;
  /** test injection: clock for the stale-directory check (default Date.now) */ now?: () => number;
}

const STALE_LOCK_MS = 15_000;
const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

type Owner = { pid: number; nonce: string; startedAt: number };
const readOwner = (dir: string): Owner | null => {
  try {
    const o = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as Owner;
    return Number.isInteger(o?.pid) && typeof o.nonce === "string" ? o : null;
  } catch { return null; }
};

/**
 * Cross-process lock next to the file (mkdir is atomic; the holder is recorded in `<lock>/owner.json`, F-vlad-245).
 * A lock is only broken when its owner pid is dead, or (no readable owner.json) the directory is older than
 * STALE_LOCK_MS; a live pid is never broken (pid reuse can only make us wait). Breaking renames the directory away first
 * (atomic: of two breakers one wins) and gives it back if it turns out to be a different, live lock. Release deletes the
 * lock only while owner.json still carries our nonce.
 */
export function withFileLock<T>(file: string, waitMs: number, fn: () => T, o: TrustOpts = {}): T | { locked: false } {
  const lock = `${file}.vlad-lock`;
  const isAlive = o.isAlive ?? pidAlive;
  const now = o.now ?? Date.now;
  const nonce = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      const tmp = join(lock, `owner.json.${nonce}.tmp`);
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, nonce, startedAt: now() } satisfies Owner));
      renameSync(tmp, join(lock, "owner.json"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") { try { rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } throw e; }
      if (breakIfStale(lock, nonce, isAlive, now)) continue;
      if (Date.now() >= deadline) return { locked: false };
      sleepMs(10 + Math.floor(Math.random() * 20));
    }
  }
  try { return fn(); } finally {
    try { if (readOwner(lock)?.nonce === nonce) rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** true when a stale lock was moved away (retry mkdir now); false when the lock stays (live owner, fresh, or lost the race). */
function breakIfStale(lock: string, nonce: string, isAlive: (pid: number) => boolean, now: () => number): boolean {
  const seen = readOwner(lock);
  try {
    const stale = seen ? !isAlive(seen.pid) : now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
    if (!stale) return false;
    const away = `${lock}.stale-${nonce}`;
    renameSync(lock, away);
    if (readOwner(away)?.nonce !== seen?.nonce) { // replaced between our check and the rename: not the lock we judged
      try { renameSync(away, lock); } catch { /* someone re-created it already; the lock we moved is lost, but it was only ever waited on */ }
      return false;
    }
    rmSync(away, { recursive: true, force: true });
    return true;
  } catch { return false; } // vanished (the other breaker won) or not movable: wait below, the deadline still applies
}

/**
 * Read-modify-write of ~/.claude.json, which live Claude processes write too: the write is atomic
 * (tmp + rename), serialized between VLAD processes by a lock, and every other field is kept. After the rename the
 * file is read back: a live Claude process that wrote between our read and rename (it does not take our lock) makes
 * the change vanish, so the edit is redone (3 tries). Never throws; returns a warning or null.
 */
function edit(file: string, change: (j: Json) => boolean, o: TrustOpts = {}): string | null {
  try {
    const r = withFileLock(file, o.lockWaitMs ?? 5000, () => {
      let last: string | null = null;
      for (let i = 0; i < 3; i++) {
        last = editOnce(file, change);
        if (last !== VERIFY_FAILED) return last;
      }
      return `${file}: güven kaydı yazıldı ama başka süreç üzerine yazdı, kayıt doğrulanamadı`;
    }, o);
    return typeof r === "object" && r !== null ? `${file} kilitli (${file}.vlad-lock), güven kaydı atlandı` : r;
  } catch (e) {
    return `${file} yazılamadı, güven kaydı atlandı: ${(e as Error).message}`;
  }
}

const VERIFY_FAILED = "\0verify";

function editOnce(file: string, change: (j: Json) => boolean): string | null {
  let j: Json = {};
  try {
    if (existsSync(file)) j = JSON.parse(readFileSync(file, "utf8")) as Json;
  } catch (e) {
    return `${file} bozuk, güven kaydı atlandı: ${(e as Error).message}`;
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return `${file} bozuk (nesne değil), güven kaydı atlandı`;
  if (!change(j)) return null;
  const tmp = `${file}.vlad-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(j, null, 2));
    renameSync(tmp, file);
    try { // read back: does the change still stand (change() returns false when it already does)?
      const again = JSON.parse(readFileSync(file, "utf8")) as Json;
      if (change(again)) return VERIFY_FAILED;
    } catch { return VERIFY_FAILED; }
    return null;
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return `${file} yazılamadı, güven kaydı atlandı: ${(e as Error).message}`;
  }
}

/** Marks a worktree as trusted so the worker skips the "Quick safety check" screen. */
export function trustWorktree(dir: string, file = claudeJsonPath(), o: TrustOpts = {}): string | null {
  const key = trustKey(dir);
  return edit(file, (j) => {
    if (j.projects?.[key]?.hasTrustDialogAccepted === true) return false;
    j.projects = { ...j.projects, [key]: { ...j.projects?.[key], hasTrustDialogAccepted: true } };
    return true;
  }, o);
}

/** Drops the trust record of a removed worktree so the file does not grow. */
export function untrustWorktree(dir: string, file = claudeJsonPath(), o: TrustOpts = {}): string | null {
  const key = trustKey(dir);
  return edit(file, (j) => {
    if (!j.projects || !(key in j.projects)) return false;
    delete j.projects[key];
    return true;
  }, o);
}
