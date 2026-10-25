import { runVladJson } from "../vlad/cli.ts";
import type { CardData, TaskData } from "../read/types.ts";
import type { EventType } from "./ledger.ts";

/**
 * What the watcher compares between two looks at the kb. Only what an event needs: ids, states and stamps.
 * (`grants` join in S10a with the `grant.used` event.)
 */
export interface Snapshot {
  tasks: Record<string, { project: string; state: string; updated: string; progress: { pct: number | null; at: string } | null }>;
  /** Open cards only. */
  cards: Record<string, { project: string }>;
  quota: { limited: boolean };
}

export interface PendingEvent {
  type: EventType;
  data: Record<string, unknown>;
  /** Dedup key; two diffs yielding the same key (a restart, a repeated look) land in the ledger once. */
  key?: string;
}

/**
 * Pure: events that turn `prev` into `next`, ordered by id so the result is deterministic. `prev === null` is a cold start:
 * it seeds, it reports nothing. Event data is an invalidation hint (ids, the new state), never titles or report text.
 */
export function diffSnapshots(prev: Snapshot | null, next: Snapshot): PendingEvent[] {
  if (!prev) return [];
  const out: PendingEvent[] = [];
  for (const id of Object.keys(next.tasks).sort()) {
    const t = next.tasks[id]!;
    const was = prev.tasks[id];
    if (!was || was.state !== t.state) {
      // one event per (task, state, updated), however often it is seen
      out.push({ type: "task.state", data: { task_id: id, project: t.project, state: t.state }, key: `task.state:${id}:${t.state}:${t.updated}` });
    } else if (t.progress && (was.progress?.at !== t.progress.at || was.progress?.pct !== t.progress.pct)) {
      out.push({ type: "worker.progress", data: { task_id: id, pct: t.progress.pct }, key: `worker.progress:${id}:${t.progress.at}:${t.progress.pct}` });
    }
  }
  for (const id of Object.keys(next.cards).sort()) {
    if (!prev.cards[id]) out.push({ type: "card.opened", data: { card_id: id, project: next.cards[id]!.project }, key: `card.opened:${id}` });
  }
  // a flip back and forth is two events, so no dedup key
  if (prev.quota.limited !== next.quota.limited) out.push({ type: "quota.changed", data: { limited: next.quota.limited } });
  return out;
}

/** Builds a snapshot from `vlad ... --json` output (S6c types). Cards that are not open are left out. */
export function toSnapshot(tasks: TaskData[], cards: CardData[], quota: { limited: boolean }): Snapshot {
  const snap: Snapshot = { tasks: {}, cards: {}, quota: { limited: !!quota.limited } };
  for (const t of tasks) {
    snap.tasks[t.id] = { project: t.project, state: t.state, updated: t.updated, progress: t.progress ? { pct: t.progress.pct, at: t.progress.at } : null };
  }
  for (const c of cards) if (c.state === "open") snap.cards[c.id] = { project: c.project };
  return snap;
}

/** Default snapshot source: three read-only `vlad` runs. A failed run rejects (the watcher keeps its previous look). */
export async function vladSnapshot(timeoutMs?: number): Promise<Snapshot> {
  const opts = { timeoutMs };
  const [tasks, cards, quota] = await Promise.all([
    runVladJson<{ tasks: TaskData[] }>(["task", "list"], opts),
    runVladJson<{ cards: CardData[] }>(["card", "list", "--state", "open"], opts),
    runVladJson<{ limited: boolean }>(["quota", "show"], opts),
  ]);
  return toSnapshot(tasks.tasks, cards.cards, quota);
}
