import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, nowIso, writeFileAtomic } from "../kb/index.js";

/**
 * Digest items that need the user's confirmation before they may be written (automatic digest, D-vlad-061):
 * an unsure decision or a "waiting for the user" open topic is queued here instead of being asked or guessed.
 * Lives in the kb (`digest-pending.json`), written only through this module (`vlad digest pending ...`).
 */
export interface PendingItem {
  id: string;
  text: string;
  task: string | null;
  project: string | null;
  created: string;
  state: "open" | "done";
  done?: string;
  note?: string | null;
}

const file = () => join(kbPaths().kb, "digest-pending.json");

function read(): PendingItem[] {
  let raw: string;
  try {
    raw = readFileSync(file(), "utf8");
  } catch {
    return []; // missing file = empty list
  }
  const o = JSON.parse(raw) as { items?: unknown }; // a corrupt file must not be silently overwritten
  if (!Array.isArray(o.items)) throw new Error("digest-pending.json bozuk: items dizisi yok");
  return o.items as PendingItem[];
}

function write(items: PendingItem[]): void {
  writeFileAtomic(file(), JSON.stringify({ items }, null, 2) + "\n");
}

export function addPending(o: { text: string; task?: string; project?: string }, now: Date = new Date()): PendingItem {
  const text = o.text.trim();
  if (!text) throw new Error("madde metni boş");
  const items = read();
  const max = items.reduce((m, i) => Math.max(m, Number(/^DP-(\d+)$/.exec(i.id)?.[1] ?? 0)), 0);
  const item: PendingItem = {
    id: `DP-${String(max + 1).padStart(3, "0")}`, text, task: o.task ?? null, project: o.project ?? null,
    created: nowIso(now), state: "open",
  };
  write([...items, item]);
  return item;
}

/** Open items (oldest first); `all` adds the closed ones. */
export function listPending(all = false): PendingItem[] {
  return read().filter((i) => all || i.state === "open");
}

export function countPending(): number {
  return listPending().length;
}

export function donePending(id: string, note?: string, now: Date = new Date()): PendingItem {
  const items = read();
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`onay bekleyen madde bulunamadı: ${id}`);
  if (item.state === "done") throw new Error(`madde zaten kapalı: ${id}`);
  item.state = "done";
  item.done = nowIso(now);
  item.note = note?.trim() || null;
  write(items);
  return item;
}
