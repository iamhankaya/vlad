import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { snapshotId } from "./snapshot.js";

/** Archived files live in `<dir>/archive/<YYYY-MM>/`; the stores read `dir` and the archive as one set. */
export const ARCHIVE = "archive";

const listed = new Map<string, { snapshot: number; files: string[] }>();

/** All `.md` files of `dir` and of its archive, sorted by file name (listed once per read snapshot, `withReadSnapshot`). */
export function listMdFiles(dir: string): string[] {
  const snap = snapshotId();
  if (snap === null) return scanMdFiles(dir);
  const hit = listed.get(dir);
  if (hit?.snapshot === snap) return [...hit.files];
  const files = scanMdFiles(dir);
  listed.set(dir, { snapshot: snap, files });
  return [...files];
}

function scanMdFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".md")) files.push(join(dir, e.name));
  }
  const arch = join(dir, ARCHIVE);
  if (existsSync(arch)) {
    for (const m of readdirSync(arch, { withFileTypes: true })) {
      if (!m.isDirectory()) continue;
      for (const f of readdirSync(join(arch, m.name))) if (f.endsWith(".md")) files.push(join(arch, m.name, f));
    }
  }
  const named = files.map((f) => ({ f, name: basename(f) }));
  return named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((x) => x.f);
}

/** Path of `<id>.md` in `dir` or its archive, or null. */
export function findMdFile(dir: string, id: string): string | null {
  const live = join(dir, `${id}.md`);
  if (existsSync(live)) return live;
  const arch = join(dir, ARCHIVE);
  if (!existsSync(arch)) return null;
  for (const m of readdirSync(arch, { withFileTypes: true })) {
    const f = join(arch, m.name, `${id}.md`);
    if (m.isDirectory() && existsSync(f)) return f;
  }
  return null;
}
