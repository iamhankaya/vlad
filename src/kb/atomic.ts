import { linkSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Writes `content` to a temp file next to `file`, then swaps it in (rename), so a failed write
 * (full disk, crash) leaves the old content untouched instead of a truncated file (F-vlad-084).
 * `exclusive`: the file must not exist yet (EEXIST), like `flag: "wx"`. `write` is a test seam.
 */
export function writeFileAtomic(
  file: string, content: string,
  o: { exclusive?: boolean; write?: (path: string, content: string) => void } = {},
): void {
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    (o.write ?? ((p, c) => writeFileSync(p, c, "utf8")))(tmp, content);
    if (o.exclusive) linkSync(tmp, file); // fails with EEXIST instead of replacing
    else renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true }); // after rename it is gone already; after link/failure it is leftover
  }
}
