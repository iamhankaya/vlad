import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../auth/files.ts";
import type { ChallengeFields } from "./challenge.ts";

/**
 * Action state machine: `prepared -> approved -> checked -> merged|failed`. `invalid` is the side exit of a challenge that
 * can no longer be used (superseded by a newer prepare, device revoked, server clock moved back).
 */
export type ActionState = "prepared" | "approved" | "checked" | "merged" | "failed" | "invalid";

const NEXT: Record<ActionState, ActionState[]> = {
  prepared: ["approved", "failed", "invalid"],
  approved: ["checked", "failed", "invalid"],
  checked: ["merged", "failed", "invalid"],
  merged: [],
  failed: [],
  invalid: [],
};
export const isTerminal = (s: ActionState) => NEXT[s].length === 0;

export type ActionResult = { merge_sha?: string };

export type ActionRecord = {
  v: 1;
  action_id: string;
  state: ActionState;
  /** Why the action is `failed` or `invalid` (a stable key such as `head_moved`, `superseded`, `revoked`). */
  reason?: string;
  /** The exact bytes the `approval` key signs. Stored once at prepare; verification never uses client-sent bytes. */
  bytes_b64: string;
  fields: ChallengeFields;
  task_id: string;
  card_id?: string;
  /** The device that asked for the challenge; only its `approval` key may approve it. */
  prepared_by: string;
  created_ms: number;
  exp: number;
  approval?: { device_id: string; signature: string; at_ms: number };
  result?: ActionResult;
  history: { state: ActionState; at_ms: number; reason?: string }[];
};

export class StateError extends Error {}

/**
 * One JSON file per action in the state directory, written atomically (tmp + fsync + rename). Mutation goes through
 * `withLock(actionId, ...)`: the single API process serialises everything on one action, so two concurrent approvals
 * cannot both pass `prepared`.
 */
export class ActionStore {
  private readonly dir: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
    ensureDir(dir);
  }

  private file(id: string) {
    if (!/^A-[A-Za-z0-9_-]{1,64}$/.test(id)) throw new StateError("geçersiz action_id");
    return join(this.dir, `${id}.json`);
  }

  get(id: string): ActionRecord | undefined {
    if (!/^A-[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined;
    return readJsonFile<ActionRecord>(this.file(id));
  }

  list(): ActionRecord[] {
    const out: ActionRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const rec = readJsonFile<ActionRecord>(join(this.dir, f));
      if (rec) out.push(rec);
    }
    return out;
  }

  /** Creates the record. Callers hold `withLock(id)`. */
  create(rec: Omit<ActionRecord, "v" | "state" | "history">): ActionRecord {
    if (this.get(rec.action_id)) throw new StateError("action_id zaten var");
    const full: ActionRecord = { ...rec, v: 1, state: "prepared", history: [{ state: "prepared", at_ms: rec.created_ms }] };
    writeJsonAtomic(this.file(rec.action_id), full);
    return full;
  }

  /** Moves to `next` (must be a legal edge) and persists; extra fields are merged in the same atomic write. Callers hold the lock. */
  transition(id: string, next: ActionState, atMs: number, patch: Partial<Pick<ActionRecord, "reason" | "approval" | "result">> = {}): ActionRecord {
    const rec = this.get(id);
    if (!rec) throw new StateError("kayıt yok");
    if (!NEXT[rec.state].includes(next)) throw new StateError(`geçersiz geçiş: ${rec.state} -> ${next}`);
    const upd: ActionRecord = { ...rec, ...patch, state: next, history: [...rec.history, { state: next, at_ms: atMs, ...(patch.reason ? { reason: patch.reason } : {}) }] };
    writeJsonAtomic(this.file(id), upd);
    return upd;
  }

  /** Runs `fn` with exclusive access to one action; calls for the same id run strictly one after the other, other ids are not blocked. */
  async withLock<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  /** Drops finished actions older than `olderThanMs` (the audit trail is the permanent record). */
  prune(nowMs: number, olderThanMs: number): number {
    let n = 0;
    for (const rec of this.list()) {
      const last = rec.history[rec.history.length - 1]?.at_ms ?? rec.created_ms;
      if (isTerminal(rec.state) && nowMs - last > olderThanMs) {
        try {
          unlinkSync(this.file(rec.action_id));
          n++;
        } catch { /* already gone */ }
      }
    }
    return n;
  }
}
