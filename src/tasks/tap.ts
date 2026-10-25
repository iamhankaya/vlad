import { appendFileSync, mkdirSync } from "node:fs";
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

/** `kb/logs/workers/<id>.jsonl` (gitignored): the raw stream lines of a worker. */
export function workerLogFile(id: string): string {
  if (!TASK_ID.test(id)) throw new Error(`geçersiz görev kimliği: ${JSON.stringify(id)}`);
  return join(kbPaths().logs, "workers", `${id}.jsonl`);
}

export function appendWorkerLog(id: string, lines: string[]): void {
  if (!lines.length) return;
  const file = workerLogFile(id);
  mkdirSync(join(kbPaths().logs, "workers"), { recursive: true });
  appendFileSync(file, lines.join("\n") + "\n", "utf8");
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
      const until = ev.until ?? new Date(now.getTime() + DEFAULT_LIMIT_MS).toISOString();
      setQuota(until, `${id}: ${ev.reason}${ev.until ? "" : " (bitiş zamanı yok, 1 saat varsayıldı)"}`, now);
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
  o: { now?: () => Date; warn?: (msg: string) => void } = {},
): Promise<void> {
  workerLogFile(id); // validates the id before any read
  getTask(id);
  const tap = new StreamTap();
  const last = { value: null as string | null };
  for await (const chunk of source) {
    const { lines, events } = tap.push(chunk);
    if (!lines.length) continue;
    const lastStep = events.map((e) => e.kind).lastIndexOf("step");
    const batch = events.filter((e, i) => e.kind !== "step" || i === lastStep);
    try {
      await withKbLock(() => {
        appendWorkerLog(id, lines);
        for (const w of activeGuard("worker", { taskId: id })) o.warn?.(w);
        applyTapEvents(id, batch, o.now?.() ?? new Date(), last);
      });
    } catch (e) {
      o.warn?.(`worker tap ${id}: ${(e as Error).message}`);
    }
  }
}
