// Takeover (kb topology note K8): sync -> `active claim --takeover` -> sync -> promote -> check main. A claim only counts once it is on main.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PromoteResult } from "./promote.ts";
import { StateStore, type TakeoverStatus } from "./state.ts";

export interface KbSyncStatus { v: 1; seq: number; at: string; ok: boolean; phase: string; error?: string; head?: string; main?: string }
export const SYNC_WAIT_MS = 20_000;
export const PROMOTE_WAIT_MS = 15_000;

const logsDir = (kbDir: string) => join(kbDir, "logs");

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const readSyncStatus = (kbDir: string): KbSyncStatus | null => {
  const s = readJson<KbSyncStatus>(join(logsDir(kbDir), "kbsync.status.json"));
  return s && s.v === 1 && Number.isSafeInteger(s.seq) ? s : null;
};

/**
 * Asks `vlad-kbsync` for an immediate cycle (`logs/kbsync.request`, which its path unit watches). The returned `seq` is above every
 * request and every handled cycle seen so far. The file is the agent's side of the kb, so it is only a hint (K9).
 */
export function requestSync(kbDir: string, reason: string, now: () => number = Date.now): number {
  const dir = logsDir(kbDir);
  const prev = Math.max(readJson<{ seq?: number }>(join(dir, "kbsync.request"))?.seq ?? 0, readSyncStatus(kbDir)?.seq ?? 0);
  const seq = (Number.isSafeInteger(prev) && prev > 0 ? prev : 0) + 1;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "kbsync.request");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ seq, at: new Date(now()).toISOString(), reason }) + "\n");
  renameSync(tmp, file);
  return seq;
}

/** Waits for a finished cycle that saw request `seq` (or a later one); null on timeout. */
export async function waitSync(
  kbDir: string, seq: number,
  o: { timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<KbSyncStatus | null> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (o.timeoutMs ?? SYNC_WAIT_MS);
  for (;;) {
    const s = readSyncStatus(kbDir);
    if (s && s.seq >= seq) return s;
    if (now() >= deadline) return null;
    await sleep(200);
  }
}

export type TakeoverErrorCode = "kb_conflict" | "kb_sync_unavailable" | "takeover_in_progress";
export class TakeoverError extends Error {
  readonly code: TakeoverErrorCode;
  constructor(code: TakeoverErrorCode, message: string) {
    super(message);
    this.name = "TakeoverError";
    this.code = code;
  }
}

export type TakeoverResult = { state: "active" } | { state: "pending"; reason: string };

export interface TakeoverDeps {
  serverMachine: string;
  stateDir: string;
  requestSync(reason: string): number;
  waitSync(seq: number): Promise<KbSyncStatus | null>;
  /** `vlad active claim --takeover --json`: writes `active.md`, no git. */
  claim(): Promise<void>;
  promote(o: { trigger: "takeover"; waitLockMs: number }): Promise<PromoteResult>;
  /** Machine named by the `active.md` of main in `vladapi`'s own clone (never the agent's clone). */
  mainActive(): Promise<string | null>;
  now(): number;
}

const record = (store: StateStore, now: number, t: Omit<TakeoverStatus, "at">) => store.update((s) => { s.takeover = { ...t, at: new Date(now).toISOString() }; });

/** One takeover at a time: a second request while one runs gets `takeover_in_progress`. */
export function createTakeover(d: TakeoverDeps): () => Promise<TakeoverResult> {
  const store = new StateStore(d.stateDir);
  let running = false;
  return async () => {
    if (running) throw new TakeoverError("takeover_in_progress", "devralma sürüyor");
    running = true;
    try {
      // 1. pull whatever main has before claiming: a conflict here means the claim could not land anyway
      const pre = await d.waitSync(d.requestSync("takeover"));
      if (!pre) throw new TakeoverError("kb_sync_unavailable", "kbsync yanıt vermedi");
      if (!pre.ok) throw new TakeoverError(pre.error === "kb_conflict" ? "kb_conflict" : "kb_sync_unavailable", `kbsync: ${pre.error ?? "başarısız"}`);
      // 2. the claim itself (git-free), 3. push it to kb-server
      await d.claim();
      const post = await d.waitSync(d.requestSync("takeover-claim"));
      const pend = (reason: string): TakeoverResult => { record(store, d.now(), { state: "pending", reason }); return { state: "pending", reason }; };
      if (!post) return pend("kb_sync_unavailable");
      if (!post.ok) return pend(post.error === "kb_conflict" ? "kb_conflict" : "kb_sync_unavailable");
      // 4. promote now, and look at what main says
      const r = await d.promote({ trigger: "takeover", waitLockMs: PROMOTE_WAIT_MS });
      if (!r.promoted && r.reason !== "up_to_date") return pend(r.reason ?? "git_error");
      const machine = await d.mainActive();
      if (machine === d.serverMachine) { record(store, d.now(), { state: "active" }); return { state: "active" }; }
      return pend("active_elsewhere");
    } finally {
      running = false;
    }
  };
}

/**
 * After every promote run: a pending takeover becomes `active` when main names this server, and `lost` when main names another
 * machine (main wins, K4). Needs a fetched main, so only a run that got that far counts.
 */
export async function settlePendingTakeover(d: Pick<TakeoverDeps, "serverMachine" | "stateDir" | "mainActive" | "now">, result: PromoteResult): Promise<TakeoverStatus["state"] | null> {
  const store = new StateStore(d.stateDir);
  const cur = store.read().takeover;
  if (cur?.state !== "pending" || !result.main) return null;
  const machine = await d.mainActive();
  if (!machine) return null;
  const state = machine === d.serverMachine ? "active" : "lost";
  record(store, d.now(), { state });
  return state;
}
