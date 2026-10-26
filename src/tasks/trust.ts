import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.claude.json`; VLAD_CLAUDE_JSON overrides it (tests must never touch the real file). */
export const claudeJsonPath = (): string => process.env.VLAD_CLAUDE_JSON || join(homedir(), ".claude.json");

/** Claude Code keys `projects` by the path with forward slashes. */
export const trustKey = (dir: string): string => dir.replaceAll("\\", "/");

type Json = { projects?: Record<string, Record<string, unknown>> } & Record<string, unknown>;

/**
 * Read-modify-write of ~/.claude.json, which live Claude processes write too: the write is atomic
 * (tmp + rename) and every other field is kept. Never throws; returns a warning or null.
 * shortcut: a write by another process between our read and rename is lost, upgrade to a lock if that bites.
 */
function edit(file: string, change: (j: Json) => boolean): string | null {
  let j: Json = {};
  try {
    if (existsSync(file)) j = JSON.parse(readFileSync(file, "utf8")) as Json;
  } catch (e) {
    return `${file} bozuk, güven kaydı atlandı: ${(e as Error).message}`;
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return `${file} bozuk (nesne değil), güven kaydı atlandı`;
  if (!change(j)) return null;
  const tmp = `${file}.vlad-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(j, null, 2));
    renameSync(tmp, file);
    return null;
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return `${file} yazılamadı, güven kaydı atlandı: ${(e as Error).message}`;
  }
}

/** Marks a worktree as trusted so the worker skips the "Quick safety check" screen. */
export function trustWorktree(dir: string, file = claudeJsonPath()): string | null {
  const key = trustKey(dir);
  return edit(file, (j) => {
    if (j.projects?.[key]?.hasTrustDialogAccepted === true) return false;
    j.projects = { ...j.projects, [key]: { ...j.projects?.[key], hasTrustDialogAccepted: true } };
    return true;
  });
}

/** Drops the trust record of a removed worktree so the file does not grow. */
export function untrustWorktree(dir: string, file = claudeJsonPath()): string | null {
  const key = trustKey(dir);
  return edit(file, (j) => {
    if (!j.projects || !(key in j.projects)) return false;
    delete j.projects[key];
    return true;
  });
}
