import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { kbPaths } from "./home.js";

/**
 * Writes that must not follow a symlink an agent planted in the kb (security review, finding 1): the server's `vladapi` also runs
 * the CLI, and the kb is writable by the agent. A final-component symlink is replaced, never followed; a symlinked ancestor between the
 * kb root and the file is refused; on Linux the file is created relative to an already-opened directory (`/proc/self/fd/<n>`), so swapping the
 * directory for a symlink after the check changes nothing.
 */

const kbRoot = (): string | undefined => {
  try {
    return kbPaths().kb;
  } catch {
    return undefined;
  }
};

const inside = (child: string, root: string): boolean => child === root || child.startsWith(root + sep);

/** Every directory from `root` (exclusive) down to `dir` must be a real directory, not a symlink. */
function assertNoSymlinkAncestors(dir: string, root: string): void {
  const rel = relative(resolve(root), resolve(dir));
  if (rel.startsWith("..")) return; // not under the kb: nothing to hold it to
  let cur = resolve(root);
  for (const seg of rel.split(sep).filter(Boolean)) {
    cur = join(cur, seg);
    if (lstatSync(cur).isSymbolicLink()) throw new Error(`symlink üst klasör: ${cur}`);
  }
}

export interface DirHandle { path(name: string): string; close(): void }

/**
 * Opens `dir` without following a symlink at its last component (`O_DIRECTORY|O_NOFOLLOW`) after checking its ancestors up to `root`.
 * On Linux the returned `path()` addresses entries through the open descriptor; elsewhere it is the plain path (the ancestor check still applies).
 * `afterOpen` runs between the open and the first use (tests swap the directory there).
 */
export function openDirSafe(dir: string, root: string | undefined = kbRoot(), afterOpen?: () => void): DirHandle {
  if (root) assertNoSymlinkAncestors(dir, root);
  if (process.platform !== "linux") return { path: (n) => join(dir, n), close() {} };
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (root) {
      const real = readlinkSync(`/proc/self/fd/${fd}`);
      const realRoot = realpathSync(root);
      if (!inside(real, realRoot)) throw new Error(`kb dışına çıkan klasör: ${dir}`);
    }
    afterOpen?.();
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return { path: (n) => `/proc/self/fd/${fd}/${n}`, close: () => closeSync(fd) };
}

/** Replaces `file` atomically: unpredictable temp name opened `O_EXCL|O_NOFOLLOW`, then `rename` (which replaces a symlink at `file` itself, not its target). */
export function safeWriteFile(file: string, text: string, o: { root?: string; afterOpen?: () => void } = {}): void {
  const d = openDirSafe(dirname(file), o.root ?? kbRoot(), o.afterOpen);
  try {
    const name = basename(file);
    const tmpName = `.${name}.${randomBytes(8).toString("hex")}.tmp`;
    const fd = openSync(d.path(tmpName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
    try {
      writeSync(fd, text, null, "utf8");
    } catch (e) {
      closeSync(fd);
      try { unlinkSync(d.path(tmpName)); } catch { /* gone */ }
      throw e;
    }
    closeSync(fd);
    try {
      renameSync(d.path(tmpName), d.path(name));
    } catch (e) {
      try { unlinkSync(d.path(tmpName)); } catch { /* gone */ }
      throw e;
    }
  } finally {
    d.close();
  }
}

/** Appends to a regular file; a symlink at `file` (or above it) is refused. */
export function safeAppendFile(file: string, text: string, o: { root?: string } = {}): void {
  const d = openDirSafe(dirname(file), o.root ?? kbRoot());
  try {
    const fd = openSync(d.path(basename(file)), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o666);
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`düzenli dosya değil: ${file}`);
      writeSync(fd, text, null, "utf8");
    } finally {
      closeSync(fd);
    }
  } finally {
    d.close();
  }
}
