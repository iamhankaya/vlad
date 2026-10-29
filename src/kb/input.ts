import { readFileSync, readSync } from "node:fs";

const MAX_EAGAIN = 2000;
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Reads stdin to the end; a non-blocking pipe throws EAGAIN when empty, so wait and retry instead of failing (F-vlad-008). `read`/`sleep` are test seams. */
export function readStdinSync(
  read: (buf: Buffer) => number | Buffer = (buf) => readSync(0, buf, 0, buf.length, null),
  sleep: (ms: number) => void = sleepMs,
): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (let waits = 0; ;) {
    let n: number;
    try {
      const r = read(buf);
      if (Buffer.isBuffer(r)) { if (!r.length) break; chunks.push(r); continue; }
      n = r;
    } catch (e) {
      if ((e as { code?: string }).code !== "EAGAIN" || ++waits > MAX_EAGAIN) throw e;
      sleep(5);
      continue;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a file; "-" means stdin. */
export function readInput(p: string): string {
  return p === "-" ? readStdinSync() : readFileSync(p, "utf8");
}
