import type { Snapshot } from "./diff.ts";
import { diffSnapshots } from "./diff.ts";
import type { EventLedger } from "./ledger.ts";

export interface WatcherDeps {
  ledger: EventLedger;
  snapshot: () => Promise<Snapshot>;
  /** Called when a snapshot failed (the previous look stays; nothing is emitted). */
  onError?: (e: unknown) => void;
}

/**
 * Looks at the kb through `snapshot`, appends the difference to the ledger. `poll()` calls never overlap: one that arrives
 * while another runs makes exactly one more look after it. The first successful look only seeds (no events).
 */
export class EventWatcher {
  private prev: Snapshot | null = null;
  private running: Promise<number> | null = null;
  private again = false;
  private readonly d: WatcherDeps;

  constructor(d: WatcherDeps) {
    this.d = d;
  }

  /** Resolves with the number of events appended by this look. */
  poll(): Promise<number> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop();
    return this.running;
  }

  private async loop(): Promise<number> {
    let appended = 0;
    // `running` is cleared in the same synchronous step that sees `again` false, so a poll can never slip between the two.
    try {
      do {
        this.again = false;
        try {
          const next = await this.d.snapshot();
          appended += this.apply(next);
        } catch (e) {
          this.d.onError?.(e); // a failed look or a failed append (disk full, EACCES...): the previous look stays, the next poll retries
        }
      } while (this.again);
    } finally {
      this.running = null;
    }
    return appended;
  }

  /**
   * Appends the difference and then adopts `next`. If an append throws, `prev` is not advanced, so the next look re-derives the
   * rest: keyed events dedup in the ledger. The one keyless event (`quota.changed`) is recorded in `prev` as soon as it is written,
   * so a retry never writes it twice.
   */
  private apply(next: Snapshot): number {
    let n = 0;
    for (const ev of diffSnapshots(this.prev, next)) {
      if (this.d.ledger.append(ev.type, ev.data, ev.key)) n++;
      if (ev.type === "quota.changed" && this.prev) this.prev = { ...this.prev, quota: next.quota };
    }
    this.prev = next;
    return n;
  }
}

export interface KbWatchDeps {
  watcher: EventWatcher;
  /** Directories to watch (`kb/tasks`, `kb/cards`, `kb/quota.json`'s dir). `fs.watch` is only a trigger: any event schedules a poll. */
  dirs: string[];
  watch: (dir: string, cb: () => void) => { close(): void };
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** Quiet period collapsing a burst of file events (and the CLI's tmp+rename) into one poll. */
  debounceMs: number;
  /** Safety net when file events are missed. */
  fallbackMs: number;
}

/** Wires file events and a fallback tick to `watcher.poll()`. Everything time-related is injected. Returns a stop function. */
export function startKbWatch(d: KbWatchDeps): () => void {
  let pending: unknown = null;
  let stopped = false;
  const schedule = () => {
    if (stopped || pending !== null) return;
    pending = d.setTimer(() => {
      pending = null;
      d.watcher.poll().catch(() => {});
    }, d.debounceMs);
  };
  const handles = d.dirs.map((dir) => d.watch(dir, schedule));
  const tick = (): void => {
    if (stopped) return;
    schedule();
    fallback = d.setTimer(tick, d.fallbackMs);
  };
  let fallback: unknown = d.setTimer(tick, d.fallbackMs);
  d.watcher.poll().catch(() => {}); // seed (poll itself reports failures through onError and does not reject)
  return () => {
    stopped = true;
    if (pending !== null) d.clearTimer(pending);
    d.clearTimer(fallback);
    for (const h of handles) h.close();
  };
}
