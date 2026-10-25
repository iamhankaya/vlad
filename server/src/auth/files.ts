import { chmodSync, closeSync, fdatasyncSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * State files of the `vladapi` user. The directory is 0700 and every file 0600; writes are atomic (tmp + fsync + rename),
 * so a crash never leaves a half-written ledger.
 */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Makes a rename/create durable: the directory entry itself must reach the disk, not only the file contents. */
export function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Appends and flushes before returning: a claimed key must survive a crash right after the response. */
export function appendDurable(path: string, line: string): void {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}
