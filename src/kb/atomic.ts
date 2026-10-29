import { linkSync, renameSync, rmSync, writeFileSync } from "node:fs";

const RENAME_RETRIES = 5;
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Windows refuses to replace a file another process has open (EPERM/EBUSY/EACCES) until it is closed; wait briefly and retry (F-vlad-091). */
function renameRetry(rename: (a: string, b: string) => void, from: string, to: string): void {
  for (let i = 0; ; i++) {
    try { return rename(from, to); } catch (e) {
      if (i >= RENAME_RETRIES || !["EPERM", "EBUSY", "EACCES"].includes((e as { code?: string }).code ?? "")) throw e;
      sleepMs(20 * (i + 1));
    }
  }
}

/**
 * Writes `content` to a temp file next to `file`, then swaps it in (rename), so a failed write
 * (full disk, crash) leaves the old content untouched instead of a truncated file (F-vlad-084).
 * `exclusive`: the file must not exist yet (EEXIST), like `flag: "wx"`. `write`/`rename` are test seams.
 */
export function writeFileAtomic(
  file: string, content: string,
  o: { exclusive?: boolean; write?: (path: string, content: string) => void; rename?: (from: string, to: string) => void } = {},
): void {
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    (o.write ?? ((p, c) => writeFileSync(p, c, "utf8")))(tmp, content);
    if (o.exclusive) linkSync(tmp, file); // fails with EEXIST instead of replacing
    else renameRetry(o.rename ?? renameSync, tmp, file);
  } finally {
    rmSync(tmp, { force: true }); // after rename it is gone already; after link/failure it is leftover
  }
}
