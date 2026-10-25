// Reads and writes of files in the agent-writable kb, by `vladapi` (security review, findings 1 and 6): never follow a symlink, never open a
// FIFO or device, never read more than a small bound.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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

const inside = (child: string, root: string): boolean => child === root || child.startsWith(root + sep);

/** Every directory from `root` (exclusive) down to `dir` must be a real directory, not a symlink. */
function assertNoSymlinkAncestors(dir: string, root: string): void {
  const rel = relative(resolve(root), resolve(dir));
  if (rel.startsWith("..")) throw new Error(`kb dışında klasör: ${dir}`);
  let cur = resolve(root);
  for (const seg of rel.split(sep).filter(Boolean)) {
    cur = join(cur, seg);
    if (lstatSync(cur).isSymbolicLink()) throw new Error(`symlink üst klasör: ${cur}`);
  }
}

export interface DirHandle { path(name: string): string; close(): void }

/**
 * Opens `dir` without following a symlink at its last component after checking its ancestors up to `root` (the kb). On Linux entries are then
 * addressed through the open descriptor (`/proc/self/fd/<n>`), so replacing the directory with a symlink after the check redirects nothing.
 * `afterOpen` runs between the open and the first use (tests swap the directory there).
 */
export function openDirSafe(dir: string, root: string, afterOpen?: () => void): DirHandle {
  assertNoSymlinkAncestors(dir, root);
  if (process.platform !== "linux") return { path: (n) => join(dir, n), close() {} };
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!inside(readlinkSync(`/proc/self/fd/${fd}`), realpathSync(root))) throw new Error(`kb dışına çıkan klasör: ${dir}`);
    afterOpen?.();
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return { path: (n) => `/proc/self/fd/${fd}/${n}`, close: () => closeSync(fd) };
}

/**
 * Replaces `file` (inside `root`, the kb) with `text` through an unpredictable `O_EXCL|O_NOFOLLOW` temp file in the same directory and a rename;
 * refuses a symlinked directory anywhere between `root` and the file. The directory is created (one level) when it is missing.
 */
export function writeFileAtomicNoFollow(file: string, text: string, root: string, afterOpen?: () => void): void {
  const dir = dirname(file);
  try {
    lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(dir, { mode: 0o770 });
  }
  const d = openDirSafe(dir, root, afterOpen);
  try {
    const name = basename(file);
    const tmp = `.${name}.${randomBytes(8).toString("hex")}.tmp`;
    const fd = openSync(d.path(tmp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o660);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(d.path(tmp), d.path(name));
    } catch (e) {
      try { unlinkSync(d.path(tmp)); } catch { /* gone */ }
      throw e;
    }
  } finally {
    d.close();
  }
}
