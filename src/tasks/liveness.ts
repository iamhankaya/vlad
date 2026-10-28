import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSection } from "../kb/index.js";
import type { TaskState, VladConfig } from "../kb/index.js";
import { listTasks, setState } from "./store.js";
import type { Task } from "./store.js";

const MIN = 60_000;
export const DEFAULT_SILENT_MINUTES = 15;
// a worker process missing this long after the last sign of life counts as dead (a fresh launch needs a moment to show up)
const NO_PROCESS_GRACE_MIN = 5;
const LIVE_FACTOR = 4;

export interface LivenessProbe {
  /** Is a process whose command line mentions the task id running? null → process list unavailable. */
  alive(taskId: string): boolean | null;
  /** Newest transcript write (ms) of the worktree's Claude project dir; null → none. */
  transcriptMtime(worktree: string): number | null;
}

/** Claude names a project dir after its path with every non-alphanumeric char mapped to `-`. */
export const claudeProjectDir = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

/** Newest `*.jsonl` mtime under `<claude config>/projects/<worktree slug>/`. */
export function transcriptMtime(worktree: string, configDir: string = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): number | null {
  const dir = join(configDir, "projects", claudeProjectDir(worktree));
  try {
    const times = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => statSync(join(dir, f)).mtimeMs);
    return times.length ? Math.max(...times) : null;
  } catch {
    return null;
  }
}

function commandLines(): string[] | null {
  try {
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine } | Where-Object { $_ }",
    ], { encoding: "utf8", windowsHide: true, timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((l) => l.toLowerCase());
  } catch {
    return null;
  }
}

export function defaultProbe(): LivenessProbe {
  let lines: string[] | null | undefined; // one process listing per status run
  return {
    alive(taskId) {
      if (lines === undefined) lines = commandLines();
      return lines ? lines.some((l) => l.includes(taskId.toLowerCase())) : null;
    },
    transcriptMtime,
  };
}

/**
 * A local worker that stopped without reporting leaves its task `running` until `staleAfterHours`.
 * Marks it `stalled` sooner: no sign of life (task file update or transcript write) for
 * `workerSilentMinutes` (4x that while a process mentions the task id), or, with no such process, for a short grace.
 * Cloud tasks, pipelines and tasks without a worktree are left alone; no-op outside Windows.
 */
export function markSilentWorkers(
  now: Date, cfg: VladConfig, probe?: LivenessProbe, platform: NodeJS.Platform = process.platform,
): Task[] {
  if (platform !== "win32") return [];
  const silentMs = (cfg.workerSilentMinutes ?? DEFAULT_SILENT_MINUTES) * MIN;
  const graceMs = Math.min(silentMs, NO_PROCESS_GRACE_MIN * MIN);
  const out: Task[] = [];
  for (const t of listTasks({ state: ["running"] })) {
    const wt = t.data.worktree;
    if (t.data.kind === "pipeline" || !wt || String(t.data.session_id ?? "").startsWith("session_")) continue;
    const updated = Date.parse(t.data.updated);
    if (Number.isNaN(updated)) continue;
    probe ??= defaultProbe();
    const idle = now.getTime() - Math.max(updated, probe.transcriptMtime(wt) ?? 0);
    if (idle < graceMs) continue;
    const alive = probe.alive(t.data.id);
    // a live process may sit in a long build/test or at a permission prompt without writing anything: give it more room
    if (alive === false || idle >= (alive ? LIVE_FACTOR * silentMs : silentMs)) out.push(setState(t.data.id, "stalled"));
  }
  return out;
}

export interface IdleTask {
  id: string; state: TaskState; project: string; title: string; idle_minutes: number; branch: string | null; last_log: string | null;
}

/** Running/blocked dev tasks whose file has not changed for `minutes`, longest idle first: the watch mode nudges these. */
export function idleTasks(now: Date, minutes: number): IdleTask[] {
  const out: IdleTask[] = [];
  for (const t of listTasks({ state: ["running", "blocked"] })) {
    if (t.data.kind === "pipeline") continue;
    const idle = Math.floor((now.getTime() - Date.parse(t.data.updated)) / MIN);
    if (!(idle >= minutes)) continue;
    const log = (getSection(t.body, "## İlerleme") ?? "").split("\n").filter(Boolean).pop() ?? null;
    out.push({ id: t.data.id, state: t.data.state, project: t.data.project, title: t.data.title, idle_minutes: idle, branch: t.data.branch ?? null, last_log: log });
  }
  return out.sort((a, b) => b.idle_minutes - a.idle_minutes);
}
