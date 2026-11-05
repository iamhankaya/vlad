import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.claude.json`; VLAD_CLAUDE_JSON overrides it (tests must never touch the real file). */
export const claudeJsonPath = (): string => process.env.VLAD_CLAUDE_JSON || join(homedir(), ".claude.json");

/** Claude Code keys `projects` by the path with forward slashes. */
export const trustKey = (dir: string): string => dir.replaceAll("\\", "/");

type Json = { projects?: Record<string, Record<string, unknown>> } & Record<string, unknown>;

export interface TrustOpts { /** how long to wait for the lock before giving up with a warning (default 5000 ms) */ lockWaitMs?: number }

const STALE_LOCK_MS = 15_000;
const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Cross-process lock next to the file (mkdir is atomic); a lock older than STALE_LOCK_MS belongs to a dead process and is broken. */
function withFileLock<T>(file: string, waitMs: number, fn: () => T): T | { locked: false } {
  const lock = `${file}.vlad-lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let broke = false;
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) { rmSync(lock, { recursive: true, force: true }); broke = true; } } catch { /* vanished or not removable: wait below, the deadline still applies */ }
      if (broke) continue;
      if (Date.now() >= deadline) return { locked: false };
      sleepMs(10 + Math.floor(Math.random() * 20));
    }
  }
  try { return fn(); } finally { try { rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } }
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
    });
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
