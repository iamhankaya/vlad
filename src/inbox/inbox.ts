import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, type InboxRecord } from "../kb/index.js";

function jsonFiles(): string[] {
  const dir = kbPaths().inbox;
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
}

/** Inbox records in name (= time) order; unreadable/broken files are skipped. */
export function listInbox(): { file: string; record: InboxRecord }[] {
  const out: { file: string; record: InboxRecord }[] = [];
  for (const file of jsonFiles()) {
    try {
      out.push({ file, record: JSON.parse(readFileSync(join(kbPaths().inbox, file), "utf8")) as InboxRecord });
    } catch {
      /* skip broken */
    }
  }
  return out;
}

export function countInbox(): number {
  return listInbox().length;
}

/** Moves the given inbox files to processed/. A missing file throws. */
export function markDone(files: string[]): void {
  const p = kbPaths();
  mkdirSync(p.processed, { recursive: true });
  for (const f of files) {
    const src = join(p.inbox, f);
    if (!existsSync(src)) throw new Error(`inbox dosyası yok: ${f}`);
    renameSync(src, join(p.processed, f));
  }
}
