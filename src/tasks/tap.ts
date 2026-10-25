import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { activeGuard } from "../active/index.js";
import { kbPaths, withKbLock } from "../kb/index.js";
import { StreamTap } from "../launcher/stream.js";
import type { TapEvent } from "../launcher/stream.js";
import { setQuota } from "../quota/index.js";
import { setProgress } from "./progress.js";
import { getTask, saveTask } from "./store.js";

const TASK_ID = /^T\d{8}-\d{2,}$/;
/** Quota marker when the stream says "limited" but gives no reset time. */
const DEFAULT_LIMIT_MS = 60 * 60_000;
/** A limit marker from the stream never reaches further than this (the stream is not trusted for long bans). */
const MAX_LIMIT_MS = 24 * 60 * 60_000;
/** Per-worker log cap; past it lines are dropped. */
export const MAX_WORKER_LOG_BYTES = 20 * 1024 * 1024;

/** `kb/logs/workers/<id>.jsonl` (gitignored): the raw stream lines of a worker. */
export function workerLogFile(id: string): string {
  if (!TASK_ID.test(id)) throw new Error(`geçersiz görev kimliği: ${JSON.stringify(id)}`);
  return join(kbPaths().logs, "workers", `${id}.jsonl`);
}

/** Appends lines to the worker log (dir 0700, file 0600) up to `maxBytes`; returns false if lines were dropped. */
export function appendWorkerLog(id: string, lines: string[], maxBytes: number = MAX_WORKER_LOG_BYTES): boolean {
  if (!lines.length) return true;
  const file = workerLogFile(id);
  mkdirSync(join(kbPaths().logs, "workers"), { recursive: true, mode: 0o700 });
  let size = existsSync(file) ? statSync(file).size : 0;
  const keep: string[] = [];
  for (const l of lines) {
    const n = Buffer.byteLength(l) + 1;
    if (size + n > maxBytes) break;
    keep.push(l);
    size += n;
  }
  if (keep.length) appendFileSync(file, keep.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  return keep.length === lines.length;
}

/**
 * Writes what a worker's stream said to the kb: `session_id` -> task, last step -> `progress` (an unchanged
 * label is not rewritten), a limit event -> quota marker. The caller holds the kb lock.
 */
export function applyTapEvents(id: string, events: TapEvent[], now: Date = new Date(), lastLabel?: { value: string | null }): void {
  for (const ev of events) {
    if (ev.kind === "session") {
      const t = getTask(id);
      if (t.data.session_id !== ev.sessionId) { t.data.session_id = ev.sessionId; saveTask(t); }
    } else if (ev.kind === "step") {
      if (lastLabel?.value === ev.label) continue;
      setProgress(id, null, ev.label);
      if (lastLabel) lastLabel.value = ev.label;
    } else {
      const cap = now.getTime() + MAX_LIMIT_MS;
      const asked = ev.until ? Date.parse(ev.until) : now.getTime() + DEFAULT_LIMIT_MS;
      const note = !ev.until ? " (bitiş zamanı yok, 1 saat varsayıldı)" : asked > cap ? " (24 saate kırpıldı)" : "";
      setQuota(new Date(Math.min(asked, cap)).toISOString(), `tap ${id}: ${ev.reason}${note}`, now);
    }
  }
}

/**
 * Consumes a worker's stream-json pipe until it ends: raw lines to the worker log, events to the task. Each
 * chunk is one short locked batch (never the whole stream), only its last step is written. A failing batch is
 * reported through `warn` and the stream keeps being read, so a kb problem never closes the pipe under `claude`.
 */
export async function tapStream(
  id: string, source: AsyncIterable<Buffer | string>,
  o: { now?: () => Date; warn?: (msg: string) => void; maxLogBytes?: number } = {},
): Promise<void> {
  workerLogFile(id); // validates the id before any read
  getTask(id);
  const tap = new StreamTap();
  const last = { value: null as string | null };
  let warnedFull = false;
  for await (const chunk of source) {
    const { lines, events } = tap.push(chunk);
    if (!lines.length) continue;
    const lastStep = events.map((e) => e.kind).lastIndexOf("step");
    const batch = events.filter((e, i) => e.kind !== "step" || i === lastStep);
    try {
      await withKbLock(() => {
        if (!appendWorkerLog(id, lines, o.maxLogBytes) && !warnedFull) {
          warnedFull = true;
          o.warn?.(`worker tap ${id}: günlük sınırına ulaşıldı, sonraki satırlar yazılmıyor`);
        }
        for (const w of activeGuard("worker", { taskId: id })) o.warn?.(w);
        applyTapEvents(id, batch, o.now?.() ?? new Date(), last);
      });
    } catch (e) {
      o.warn?.(`worker tap ${id}: ${(e as Error).message}`);
    }
  }
}
