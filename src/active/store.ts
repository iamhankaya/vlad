import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { currentMachine, kbPaths, nowIso, readDoc, validate, writeDoc } from "../kb/index.js";
import type { ActiveData } from "../kb/index.js";
import { getTask } from "../tasks/store.js";

/** The only place for the heartbeat thresholds (mobile plan, open point 5; user approval pending). */
export const ACTIVE_HEARTBEAT_WRITE_MS = 30 * 60_000;
export const ACTIVE_STALE_MS = 2 * 3_600_000;

export const activeFile = () => join(kbPaths().kb, "active.md");

/** Error key `active_elsewhere`: clients look at the code, not the Turkish text. */
export class ActiveElsewhereError extends Error {
  readonly code = "active_elsewhere";
  constructor(public record: ActiveData, ageMs: number) {
    super(`active_elsewhere: etkin VLAD "${record.machine}" (nabız ${Math.max(0, Math.round(ageMs / 60_000))} dk önce); yazmak için \`vlad active claim --takeover\``);
    this.name = "ActiveElsewhereError";
  }
}

export interface ActiveStatus {
  record: ActiveData | null;
  mine: boolean;
  /** age of the last heartbeat; negative (clock skew, writer ahead) counts as fresh */
  ageMs: number;
  /** `ageMs >= ACTIVE_STALE_MS`: exactly at the threshold is stale, one second below is fresh */
  stale: boolean;
  warnings: string[];
}

/**
 * Reads kb/active.md. Time comes from the writer's clock, so a skew between machines shifts the
 * threshold by that skew; it is minutes at worst against a 2 h limit. A missing or unreadable file means
 * "no active VLAD" (unreadable adds a warning) so a corrupt file never locks every command.
 */
export function activeStatus(opts: { now?: number; machine?: string } = {}): ActiveStatus {
  const now = opts.now ?? Date.now();
  const machine = opts.machine ?? currentMachine();
  const none: ActiveStatus = { record: null, mine: false, ageMs: 0, stale: false, warnings: [] };
  if (!existsSync(activeFile())) return none;
  let record: ActiveData;
  try {
    record = readDoc<ActiveData>(activeFile()).data;
    validate("active", record);
  } catch (e) {
    return { ...none, warnings: [`active.md yok sayıldı (${(e as Error).message})`] };
  }
  const ageMs = now - Date.parse(record.heartbeat);
  return { record, mine: record.machine === machine, ageMs, stale: ageMs >= ACTIVE_STALE_MS, warnings: [] };
}

const write = (d: ActiveData) => writeDoc(activeFile(), d, "");

/**
 * Takes the active role. Free or own: written. Other machine: fresh -> `active_elsewhere` unless
 * `takeover`; stale -> taken with a warning. Call inside withKbLock (defWrite does), so the check and
 * the write are one critical section: of two concurrent claims one wins.
 */
export function claimActive(o: { takeover?: boolean; now?: number; machine?: string } = {}): { record: ActiveData; warnings: string[] } {
  const now = o.now ?? Date.now();
  const machine = o.machine ?? currentMachine();
  const st = activeStatus({ now, machine });
  const warnings = [...st.warnings];
  const stamp = nowIso(new Date(now));
  if (st.record && st.mine) {
    const record = { ...st.record, heartbeat: stamp };
    write(record);
    return { record, warnings };
  }
  if (st.record) {
    if (!st.stale && !o.takeover) throw new ActiveElsewhereError(st.record, st.ageMs);
    if (st.stale) warnings.push(`"${st.record.machine}" nabzı bayat (${Math.round(st.ageMs / 60_000)} dk); devralındı`);
  }
  const record: ActiveData = { machine, since: stamp, heartbeat: stamp, takeover_from: st.record?.machine ?? null };
  write(record);
  return { record, warnings };
}

/** Refreshes the heartbeat, but writes at most once per ACTIVE_HEARTBEAT_WRITE_MS. Only the active machine may. */
export function heartbeatActive(o: { now?: number; machine?: string } = {}): { written: boolean; record: ActiveData } {
  const now = o.now ?? Date.now();
  const st = activeStatus({ now, machine: o.machine });
  if (!st.record) throw new Error("active kaydı yok; önce `vlad active claim`");
  if (!st.mine) throw new ActiveElsewhereError(st.record, st.ageMs);
  if (st.ageMs >= 0 && st.ageMs < ACTIVE_HEARTBEAT_WRITE_MS) return { written: false, record: st.record };
  const record = { ...st.record, heartbeat: nowIso(new Date(now)) };
  write(record);
  return { written: true, record };
}

/** Gives the role up (deletes the record). Releasing someone else's record is `active_elsewhere`. */
export function releaseActive(o: { now?: number; machine?: string } = {}): boolean {
  const st = activeStatus(o);
  if (!st.record) return false;
  if (!st.mine) throw new ActiveElsewhereError(st.record, st.ageMs);
  unlinkSync(activeFile());
  return true;
}

const TASK_ID = /^T\d{8}-\d{2,}$/;

/**
 * A worker's own `log|ask|report` may run on a non-active machine, but only for the task named by
 * `VLAD_TASK_ID`, and only while that task really is `running` in kb (a bare `VLAD_TASK_ID` is not enough: any process can set it).
 */
export function isRunningWorker(env: NodeJS.ProcessEnv = process.env, taskId?: string): boolean {
  const id = env.VLAD_TASK_ID?.trim();
  if (!id || !TASK_ID.test(id) || (taskId !== undefined && taskId !== id)) return false;
  try {
    return getTask(id).data.state === "running";
  } catch {
    return false;
  }
}

export type GuardMode = "full" | "worker" | "off";

/**
 * Write guard (design §13): another machine holds a fresh active record -> `active_elsewhere`; stale -> a
 * warning and the write continues. `worker` mode lets a running worker's own commands through; `off` skips
 * the check. No record (single-machine setup) -> always passes. Returns warnings for the caller to print.
 */
export function activeGuard(mode: GuardMode, o: { now?: number; machine?: string; env?: NodeJS.ProcessEnv; taskId?: string } = {}): string[] {
  if (mode === "off") return [];
  const st = activeStatus(o);
  if (!st.record || st.mine) return st.warnings;
  if (st.stale) return [...st.warnings, `etkin VLAD "${st.record.machine}" bayat (${Math.round(st.ageMs / 60_000)} dk); yazma sürüyor`];
  if (mode === "worker" && isRunningWorker(o.env, o.taskId)) return st.warnings;
  throw new ActiveElsewhereError(st.record, st.ageMs);
}
