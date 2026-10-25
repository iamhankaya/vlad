// Promote's own state in `<stateDir>` (`vladapi`, 0700): never in the kb, which the agent can write. Atomic writes; a corrupt file reads as empty.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TakeoverStatus = { state: "active" | "pending" | "lost"; reason?: string; at: string };
export interface PromoteState {
  v: 1;
  /** conflict key -> card id: the authoritative copy of "already raised", the agent cannot delete it (K6) */
  seen: Record<string, string>;
  /** set while a `rejected` diff keeps promote from landing */
  blocked: { key: string; card?: string; at: string } | null;
  takeover?: TakeoverStatus;
  /** last time promote ended up at `up_to_date` or landed something */
  lastOk?: string;
}

const MAX_SEEN = 1000;
const fresh = (): PromoteState => ({ v: 1, seen: {}, blocked: null });

export class StateStore {
  private readonly dir: string;
  private readonly file: string;
  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, "state.json");
  }

  read(): PromoteState {
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as PromoteState;
      if (j && j.v === 1 && j.seen && typeof j.seen === "object") return { ...fresh(), ...j };
    } catch { /* missing or corrupt */ }
    return fresh();
  }

  update(fn: (s: PromoteState) => void): PromoteState {
    const s = this.read();
    fn(s);
    const keys = Object.keys(s.seen);
    if (keys.length > MAX_SEEN) for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete s.seen[k];
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    return s;
  }
}

const STALE_LOCK_MS = 10 * 60_000;

/** Exclusive lock file (`O_EXCL`): one promote at a time, across the timer unit and a takeover request. A lock older than 10 minutes is taken over. */
export async function acquireLock(dir: string, o: { waitMs: number; now: () => number; sleep: (ms: number) => Promise<void> }): Promise<(() => void) | null> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "promote.lock");
  const start = o.now();
  for (;;) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, `${process.pid} ${o.now()}\n`);
      closeSync(fd);
      return () => { try { unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) { unlinkSync(file); continue; }
    } catch { continue; }
    if (o.now() - start >= o.waitMs) return null;
    await o.sleep(Math.min(100, Math.max(1, o.waitMs - (o.now() - start))));
  }
}
