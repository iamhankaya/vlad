import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, truncateSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendDurable, ensureDir, fsyncDir } from "../auth/files.ts";

export type EventType = "card.opened" | "task.state" | "worker.progress" | "chat.delta" | "chat.done" | "action.executed" | "grant.used" | "quota.changed";
export const EVENT_TYPES: readonly EventType[] = ["card.opened", "task.state", "worker.progress", "chat.delta", "chat.done", "action.executed", "grant.used", "quota.changed"];

/** Wire shape (`Event` in contract/openapi.yaml). */
export type LedgerEvent = { seq: number; type: EventType; data: Record<string, unknown> };
type Stored = LedgerEvent & { key?: string };

/** Retained events. Older ones are dropped at compaction; clients that fell behind see a `seq` jump and refresh via `GET /home`. */
export const MAX_EVENTS = 2000;
export const MAX_EVENT_BYTES = 4096;

/**
 * Durable event ledger (`events.jsonl`, 0600, single writer: the API process). `seq` only grows, one line per event, appended
 * with fdatasync. Memory and disk are bounded: at most {@link MAX_EVENTS} events are kept in memory; the file is rewritten
 * (tmp + rename) down to that many once it holds twice as many lines. An event with a `key` already retained is not appended
 * again (restart-safe dedup of "same (task,state,updated)").
 */
export class EventLedger {
  private readonly file: string;
  private readonly max: number;
  private events: Stored[] = [];
  private keys = new Set<string>();
  private fileLines = 0;
  private seq = 0;
  private readonly listeners: ((e: LedgerEvent) => void)[] = [];

  constructor(stateDir: string, max = MAX_EVENTS) {
    ensureDir(stateDir);
    this.file = join(stateDir, "events.jsonl");
    this.max = Math.max(1, max);
    if (existsSync(this.file)) {
      const raw = readFileSync(this.file, "utf8");
      // A crash mid-append leaves a partial last line. Cut it off, or the next append would glue onto it and reuse its seq.
      if (raw !== "" && !raw.endsWith("\n")) truncateSync(this.file, Buffer.byteLength(raw.slice(0, raw.lastIndexOf("\n") + 1)));
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as Stored;
          if (!Number.isSafeInteger(e.seq) || e.seq <= this.seq || !EVENT_TYPES.includes(e.type)) continue; // torn tail or garbage: skipped
          this.events.push(e);
          this.seq = e.seq;
          this.fileLines++;
        } catch { /* a torn last line after a crash */ }
      }
      if (this.events.length > this.max) this.events = this.events.slice(-this.max);
      for (const e of this.events) if (e.key) this.keys.add(e.key);
    }
  }

  /** Sequence number of the newest event (0 = none yet). */
  get lastSeq(): number {
    return this.seq;
  }

  /** `seq` of the oldest retained event (`lastSeq + 1` when empty). */
  get firstSeq(): number {
    return this.events[0]?.seq ?? this.seq + 1;
  }

  get size(): number {
    return this.events.length;
  }

  /** Called after each appended event (SSE fan-out, cache invalidation). Listener errors never fail the append. */
  onAppend(cb: (e: LedgerEvent) => void): void {
    this.listeners.push(cb);
  }

  /** Appends one event; returns it, or null when `key` is already retained. Data must stay a small JSON object (hint, no detail). */
  append(type: EventType, data: Record<string, unknown>, key?: string): LedgerEvent | null {
    if (key !== undefined && this.keys.has(key)) return null;
    if (JSON.stringify(data).length > MAX_EVENT_BYTES) throw new Error("event data too large");
    const rec: Stored = { seq: this.seq + 1, type, data, ...(key !== undefined ? { key } : {}) };
    appendDurable(this.file, JSON.stringify(rec) + "\n");
    this.seq = rec.seq;
    this.fileLines++;
    this.events.push(rec);
    if (key !== undefined) this.keys.add(key);
    if (this.events.length > this.max) {
      const old = this.events.shift()!;
      if (old.key) this.keys.delete(old.key);
    }
    if (this.fileLines > this.max * 2) {
      try {
        this.compact();
      } catch { /* the event is already durable; compaction is retried with the next append */ }
    }
    const out: LedgerEvent = { seq: rec.seq, type, data };
    for (const cb of this.listeners) {
      try { cb(out); } catch { /* a broken subscriber must not lose the event */ }
    }
    return out;
  }

  /** Events with `seq > after`, oldest first, at most `limit`. A first `seq` above `after + 1` means events were dropped (gap). */
  after(after: number, limit: number): LedgerEvent[] {
    const out: LedgerEvent[] = [];
    // binary search: events are seq-ascending
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid]!.seq > after) hi = mid; else lo = mid + 1;
    }
    for (let i = lo; i < this.events.length && out.length < limit; i++) {
      const { seq, type, data } = this.events[i]!;
      out.push({ seq, type, data });
    }
    return out;
  }

  /** True when `after` is older than the oldest retained event, i.e. a replay from there would skip dropped events. */
  hasGapAfter(after: number): boolean {
    return this.seq > 0 && after + 1 < this.firstSeq;
  }

  private compact(): void {
    const tmp = this.file + ".tmp";
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, this.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    fsyncDir(dirname(this.file));
    this.fileLines = this.events.length;
  }
}
