// `active_vlad.takeover` and `active_vlad.kb_sync` of GET /home (kb topology note, API). Promote's own state plus the kbsync status file
// (which the agent can write: it only says "stale" or "conflict" here, never "ok" about main).
import { readSyncStatus } from "./takeover.ts";
import { StateStore } from "./state.ts";

export const STALE_AFTER_MS = 5 * 60_000;
const ts = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export interface KbSyncView { state: "ok" | "conflict" | "blocked" | "stale"; last_ok: string | null; card?: string }

export function kbSyncView(o: { kbDir: string; stateDir: string; now: () => number }): { takeover?: { state: string; reason?: string; at: string }; kb_sync: KbSyncView } {
  const st = new StateStore(o.stateDir).read();
  // `ok` comes only from promote's own last clean run (state.json, not agent-writable). The kbsync status file is the agent's: it can
  // say "conflict" (a downgrade), never "ok".
  const sync = readSyncStatus(o.kbDir);
  const lastOk = st.lastOk ? Date.parse(st.lastOk) : NaN;
  let state: KbSyncView["state"] = "ok";
  if (st.blocked) state = "blocked";
  else if (sync && !sync.ok && sync.error === "kb_conflict") state = "conflict";
  else if (!Number.isFinite(lastOk) || o.now() - lastOk > STALE_AFTER_MS) state = "stale";
  return {
    ...(st.takeover ? { takeover: { state: st.takeover.state, ...(st.takeover.reason ? { reason: st.takeover.reason } : {}), at: st.takeover.at } } : {}),
    kb_sync: { state, last_ok: Number.isFinite(lastOk) ? ts(lastOk) : null, ...(st.blocked?.card ? { card: st.blocked.card } : {}) },
  };
}
