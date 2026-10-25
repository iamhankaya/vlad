// Reads and writes of files in the agent-writable kb, by `vladapi` (security review, findings 1 and 6): never follow a symlink, never open a
// FIFO or device, never read more than a small bound.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const MAX_STATUS_BYTES = 64 * 1024;

/** Contents of a small regular file, or null when it is missing, a symlink, not a regular file, too large, or unreadable. */
export function readSmallFile(file: string, max = MAX_STATUS_BYTES): string | null {
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO planted in the kb must not hang the server
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export const readSmallJson = <T>(file: string): T | null => {
  const t = readSmallFile(file);
  if (t === null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
};

/** Replaces `file` with `text` through an unpredictable `O_EXCL|O_NOFOLLOW` temp file in the same directory and a rename; refuses a symlinked directory. */
export function writeFileAtomicNoFollow(file: string, text: string): void {
  const dir = dirname(file);
  try {
    lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(dir, { mode: 0o770 });
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`güvenli olmayan klasör: ${dir}`);
  const tmp = join(dir, `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o660);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
}
