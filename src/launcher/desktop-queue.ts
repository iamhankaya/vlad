import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeFileAtomic } from "../kb/atomic.js";
import { externalLaunch } from "./terminal.js";
import type { LaunchRequest, LaunchResult, Launcher } from "./types.js";

/** Queue contract shared with vlad-desktop (T20261103-15): one `<taskId>.json` per request. */
export interface DesktopQueueRequest {
  v: 1;
  kind: "launch" | "resume";
  taskId: string;
  script: string;
  cwd: string;
  createdAt: string;
  pid: number;
}

export type DesktopQueueState = { dir: string } | { dir: null; warning?: string };

/**
 * vlad-desktop sets VLAD_DESKTOP_QUEUE on the main VLAD tab only. Unset → no queue (silent); set but not an existing
 * absolute directory → no queue plus a warning (the caller falls back to the usual launch). Windows only (.ps1 scripts).
 */
export function desktopQueueDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DesktopQueueState {
  const raw = env.VLAD_DESKTOP_QUEUE?.trim();
  if (!raw || platform !== "win32") return { dir: null };
  const isDir = (): boolean => { try { return statSync(raw).isDirectory(); } catch { return false; } };
  if (!isAbsolute(raw) || !isDir()) {
    return { dir: null, warning: `VLAD_DESKTOP_QUEUE kullanılamıyor (mutlak, var olan klasör değil): ${raw}; normal başlatmaya düşülüyor` };
  }
  return { dir: raw };
}

/** Atomically (temp name + rename) writes `<dir>/<taskId>.json`. Throws when the folder is not writable. */
export function enqueueDesktop(dir: string, req: Omit<DesktopQueueRequest, "v" | "createdAt" | "pid"> & { createdAt?: string; pid?: number }): string {
  const body: DesktopQueueRequest = { v: 1, createdAt: new Date().toISOString(), pid: process.pid, ...req };
  const file = join(dir, `${req.taskId}.json`);
  writeFileAtomic(file, JSON.stringify(body));
  return file;
}

/**
 * Wraps the external launcher: prepares the script like `--external`, then queues it for vlad-desktop. If the queue file
 * cannot be written, warns and falls back to `fallback` (the usual terminal window).
 */
export function queueLauncher(dir: string, kind: DesktopQueueRequest["kind"], fallback: Launcher, scriptDir?: string): Launcher {
  return {
    async launch(req: LaunchRequest): Promise<LaunchResult> {
      const ext = externalLaunch(req, scriptDir);
      if (!ext.ok || !ext.script || !ext.cwd) return ext;
      try {
        const queued = enqueueDesktop(dir, { kind, taskId: req.taskId, script: ext.script, cwd: ext.cwd });
        return { ...ext, method: "desktop-queue", queued };
      } catch (e) {
        process.stderr.write(`uyarı: kuyruk yazılamadı (${(e as Error).message}); dış pencere açılıyor\n`);
        return fallback.launch(req);
      }
    },
  };
}
