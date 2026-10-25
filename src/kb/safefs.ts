import { closeSync, constants, fstatSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * Writes that must not follow a symlink an agent planted in the kb (security review, finding 1): the server's `vladapi` also runs
 * the CLI, and the kb is writable by the agent. A final-component symlink is replaced, never followed; an ancestor directory that is a symlink is refused.
 */
function assertRealParent(file: string): void {
  try {
    if (lstatSync(dirname(file)).isSymbolicLink()) throw new Error(`symlink üst klasör: ${dirname(file)}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Replaces `file` atomically: unpredictable temp name opened `O_EXCL|O_NOFOLLOW`, then `rename` (which replaces a symlink at `file` itself, not its target). */
export function safeWriteFile(file: string, text: string): void {
  assertRealParent(file);
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
  try {
    writeSync(fd, text, null, "utf8");
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
}

/** Appends to a regular file; a symlink at `file` (or above it) is refused. */
export function safeAppendFile(file: string, text: string): void {
  assertRealParent(file);
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o666);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`düzenli dosya değil: ${file}`);
    writeSync(fd, text, null, "utf8");
  } finally {
    closeSync(fd);
  }
}
