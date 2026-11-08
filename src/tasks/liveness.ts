import { execFile, execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSection, kbPaths, readDoc } from "../kb/index.js";
import type { TaskState, VladConfig } from "../kb/index.js";
import { existsSync } from "node:fs";
import { repoNameOf } from "../fleet/paths.js";
import type { RemoteTransport } from "../fleet/types.js";
import { RemoteError } from "../fleet/types.js";
import { getTask, listTasks, logTask, setState } from "./store.js";
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
  /** Does the worker's tmux pane show Claude Code's "trust this folder" screen? (F-vlad-261; detection only, never answers it) */
  trustScreen?(taskId: string): boolean;
}

/** Claude Code's folder trust prompt ("Quick safety check" / "Do you trust the files in this folder?"). */
export const trustScreenShown = (pane: string): boolean => /quick safety check|trust (the files in )?this folder/i.test(pane);
// the screen is normal for a moment after launch; a worker still parked there after this is stuck
const TRUST_GRACE_MIN = 3;
const tmuxPane = (taskId: string): string => {
  try { return execFileSync("tmux", ["capture-pane", "-p", "-t", `vlad-${taskId}`], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
};

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

/** The session id of the worktree's only Claude transcript; null when there is none or several (`--continue` would guess, F-vlad-097). */
export function soleTranscriptSession(worktree: string, configDir: string = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): string | null {
  try {
    const files = readdirSync(join(configDir, "projects", claudeProjectDir(worktree))).filter((f) => f.endsWith(".jsonl"));
    return files.length === 1 ? files[0].slice(0, -".jsonl".length) : null;
  } catch {
    return null;
  }
}

/** Process listing command: PowerShell on Windows, `ps` elsewhere (F-vlad-111: macOS/Linux workers were never marked stalled). */
const listCommand = (): [string, string[]] => process.platform === "win32"
  ? ["powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine } | Where-Object { $_ }",
  ]]
  : ["ps", ["-ww", "-eo", "args="]];

/** One lower-cased command line per non-empty output line. */
export const parseProcessList = (out: string): string[] => out.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean);

function commandLines(): string[] | null {
  try {
    const [cmd, args] = listCommand();
    return parseProcessList(execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

/** Async process listing for the Agent (never blocks its event loop); null on failure or timeout. */
export function commandLinesAsync(timeoutMs: number): Promise<string[] | null> {
  return new Promise((resolve) => {
    const [cmd, args] = listCommand();
    execFile(cmd, args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, out) => resolve(err ? null : parseProcessList(out)));
  });
}

export function defaultProbe(): LivenessProbe {
  let lines: string[] | null | undefined; // one process listing per status run
  return {
    alive(taskId) {
      if (lines === undefined) lines = commandLines();
      return lines ? lines.some((l) => l.includes(taskId.toLowerCase())) : null;
    },
    transcriptMtime,
    trustScreen: (taskId) => process.platform !== "win32" && trustScreenShown(tmuxPane(taskId)),
  };
}

export interface SilenceInput {
  /** ms since the last sign of life (local: task file / transcript; remote: min of the task file age and the worker's ageMs) */
  idleMs: number;
  /** a process mentions the task id; null → process list unavailable */
  alive: boolean | null;
  silentMs: number;
}

/** Pure core of the silence check, shared by the local (markSilentWorkers) and the remote (probeRemoteWorkers) path. */
export function decideSilent({ idleMs, alive, silentMs }: SilenceInput): boolean {
  if (idleMs < Math.min(silentMs, NO_PROCESS_GRACE_MIN * MIN)) return false;
  // a live process may sit in a long build/test or at a permission prompt without writing anything: give it more room
  return alive === false || idleMs >= (alive ? LIVE_FACTOR * silentMs : silentMs);
}

/** Drive-letter or UNC path (a Windows worktree); anything else is POSIX-style. */
const isWindowsPath = (p: string): boolean => /^([A-Za-z]:[\\/]|\\\\)/.test(p);

/**
 * A local worker that stopped without reporting leaves its task `running` until `staleAfterHours`.
 * Marks it `stalled` sooner: no sign of life (task file update or transcript write) for
 * `workerSilentMinutes` (4x that while a process mentions the task id), or, with no such process, for a short grace.
 * Cloud tasks, pipelines and tasks without a worktree are left alone; `ps` stands in for PowerShell on macOS/Linux.
 */
export function markSilentWorkers(now: Date, cfg: VladConfig, probe?: LivenessProbe, platform: NodeJS.Platform = process.platform): Task[] {
  const silentMs = (cfg.workerSilentMinutes ?? DEFAULT_SILENT_MINUTES) * MIN;
  const out: Task[] = [];
  for (const t of listTasks({ state: ["running"] })) {
    const wt = t.data.worktree;
    if (t.data.kind === "pipeline" || !wt || String(t.data.session_id ?? "").startsWith("session_")) continue;
    if (cfg.machines && t.data.machine && t.data.machine !== cfg.brain) continue; // worker machine: its worktree/transcripts are not here (remote probe: C3)
    if (isWindowsPath(wt) !== (platform === "win32")) continue; // F-vlad-195: another OS's worktree: liveness unknown here, never "silent"
    const updated = Date.parse(t.data.updated);
    if (Number.isNaN(updated)) continue;
    probe ??= defaultProbe();
    const transcript = probe.transcriptMtime(wt);
    const idleMs = now.getTime() - Math.max(updated, transcript ?? 0);
    // F-vlad-261: no transcript yet + parked on the trust screen = stuck for good (nothing answers it); flag it, never auto-approve
    if (transcript === null && idleMs >= TRUST_GRACE_MIN * MIN && probe.trustScreen?.(t.data.id)) {
      logTask(t.data.id, "güven ekranında takıldı (Quick safety check): ~/.claude.json güven kaydı yok; pencerede onayla ya da `vlad task resume`");
      out.push(setState(t.data.id, "stalled", { error: "çalışan güven ekranında takıldı (hasTrustDialogAccepted kaydı yok)" }));
      continue;
    }
    if (idleMs < Math.min(silentMs, NO_PROCESS_GRACE_MIN * MIN)) continue; // skip the process listing while clearly fresh
    if (decideSilent({ idleMs, alive: probe.alive(t.data.id), silentMs })) out.push(setState(t.data.id, "stalled"));
  }
  return out;
}

/** Result of one remote probe round for a task; applied later under the kb lock (no network inside the lock). */
export interface RemoteStallPlan {
  id: string;
  /** the task's `updated` when it was probed: a task written since is left alone */
  updated: string;
  machine: string;
  reason: "silent" | "unreachable";
}

export const REMOTE_BUDGET_MS = 4000;
const UNREACHABLE = new Set(["unreachable", "timeout"]);

function repoNameOfProject(project: string): string | null {
  const f = join(kbPaths().projects, `${project}.md`);
  if (!existsSync(f)) return null;
  const path = (readDoc<{ path?: string }>(f).data.path ?? "");
  return path ? repoNameOf(path) : null;
}

/**
 * Remote half of the silence check (machines C3): one `liveness` call per worker machine, all machines in parallel,
 * 4 s in total (a machine over budget counts as unreachable). The worker answers with `ageMs` (its own clock difference), so
 * clock skew never matters. Pure read: marking happens in `applyRemoteStalls`. Only `status` (mark on) calls this.
 */
export async function probeRemoteWorkers(
  cfg: VladConfig, transport: RemoteTransport, now: Date, o: { budgetMs?: number } = {},
): Promise<RemoteStallPlan[]> {
  if (!cfg.machines) return [];
  const silentMs = (cfg.workerSilentMinutes ?? DEFAULT_SILENT_MINUTES) * MIN;
  const budget = o.budgetMs ?? REMOTE_BUDGET_MS;
  const byMachine = new Map<string, Task[]>();
  for (const t of listTasks({ state: ["running"] })) {
    const m = t.data.machine;
    if (t.data.kind === "pipeline" || !m || m === cfg.brain || String(t.data.session_id ?? "").startsWith("session_")) continue;
    if (!cfg.machines.some((d) => d.name === m)) continue;
    byMachine.set(m, [...(byMachine.get(m) ?? []), t]);
  }
  const deadline = Date.now() + budget;
  const one = async ([machine, tasks]: [string, Task[]]): Promise<RemoteStallPlan[]> => {
    const asks = tasks.flatMap((t) => {
      try { const repoName = repoNameOfProject(t.data.project); return repoName ? [{ t, ask: { id: t.data.id, project: t.data.project, repoName } }] : []; } catch { return []; } // one broken card must not hide the others
    });
    if (!asks.length) return [];
    const idleOf = (t: Task) => now.getTime() - Date.parse(t.data.updated);
    const plan = (t: Task, reason: RemoteStallPlan["reason"]): RemoteStallPlan => ({ id: t.data.id, updated: t.data.updated, machine, reason });
    let timer: NodeJS.Timeout | undefined;
    try {
      const left = Math.max(1, deadline - Date.now());
      const guard = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new RemoteError("timeout", `timeout: ${machine} liveness ${budget} ms bütçesini aştı`, machine)), left); });
      const r = await Promise.race([transport.call<{ results?: Record<string, { ageMs: number | null; hasProcess: boolean }> }>(machine, "liveness", { tasks: asks.map((a) => a.ask) }, { timeoutMs: left }), guard]);
      const out: RemoteStallPlan[] = [];
      for (const { t } of asks) {
        const probe = r.result?.results?.[t.data.id];
        if (!probe) continue; // no answer for this task: unknown, not silent
        const idleMs = Math.min(idleOf(t), probe.ageMs ?? Infinity);
        if (Number.isNaN(idleMs)) continue;
        if (decideSilent({ idleMs, alive: probe.hasProcess, silentMs })) out.push(plan(t, "silent"));
      }
      return out;
    } catch (e) {
      // only an unreachable machine marks tasks (after the silence threshold); a refusal or a failed op proves nothing
      if (!(e instanceof RemoteError) || !UNREACHABLE.has(e.code)) return [];
      return asks.filter(({ t }) => idleOf(t) >= silentMs).map(({ t }) => plan(t, "unreachable"));
    } finally {
      clearTimeout(timer);
    }
  };
  return (await Promise.all([...byMachine].map(one))).flat();
}

/** Marks the planned tasks `stalled` (kb lock held by the caller); a task that changed since the probe is left alone. */
export function applyRemoteStalls(plans: RemoteStallPlan[]): Task[] {
  const out: Task[] = [];
  for (const p of plans) {
    let t: Task;
    try { t = getTask(p.id); } catch { continue; }
    if (t.data.state !== "running" || t.data.updated !== p.updated || t.data.machine !== p.machine) continue;
    out.push(setState(p.id, "stalled", p.reason === "unreachable" ? { error: `makine erişilemiyor: ${p.machine}` } : {}));
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
