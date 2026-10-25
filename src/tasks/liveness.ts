import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VladConfig } from "../kb/index.js";
import { listTasks, setState } from "./store.js";
import type { Task } from "./store.js";

const MIN = 60_000;
export const DEFAULT_SILENT_MINUTES = 15;
// a worker process missing this long after the last sign of life counts as dead (a fresh launch needs a moment to show up)
const NO_PROCESS_GRACE_MIN = 5;

export interface LivenessProbe {
  /** Is a process whose command line mentions the task id running? null → process list unavailable. */
  alive(taskId: string): boolean | null;
  /** Newest transcript write (ms) of the worktree's Claude project dir; null → none. */
  transcriptMtime(worktree: string): number | null;
}

/** Newest `*.jsonl` mtime under `<claude config>/projects/<worktree slug>/`; claude maps every non-alphanumeric path char to `-`. */
export function transcriptMtime(worktree: string, configDir: string = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): number | null {
  const dir = join(configDir, "projects", worktree.replace(/[^A-Za-z0-9]/g, "-"));
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
 * `workerSilentMinutes`, or, with no worker process mentioning the task id, for a short grace.
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
    if (idle >= silentMs || probe.alive(t.data.id) === false) out.push(setState(t.data.id, "stalled"));
  }
  return out;
}
