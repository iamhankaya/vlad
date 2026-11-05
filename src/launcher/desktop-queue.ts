import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { writeFileAtomic } from "../kb/atomic.js";
import { externalLaunch } from "./terminal.js";
import type { LaunchRequest, LaunchResult, Launcher } from "./types.js";

/** Queue contract shared with vlad-desktop (T20261103-15, v2 T20261103-23): one `<taskId>.json` per request. */
export interface DesktopQueueRequest {
  v: 2;
  kind: "launch" | "resume";
  taskId: string;
  script: string;
  /** SHA-256 of the script file bytes, lowercase hex (64 chars). */
  scriptSha256: string;
  cwd: string;
  createdAt: string;
  pid: number;
}

export type DesktopQueueState = { dir: string } | { dir: null; warning?: string };

/**
 * vlad-desktop sets VLAD_DESKTOP_QUEUE on the main VLAD tab only. Unset → no queue (silent); set but not an existing
 * absolute directory → no queue plus a warning (the caller falls back to the usual launch). Windows queues `.ps1`
 * scripts, macOS/Linux `.sh`; on POSIX the folder must also be a real (non-symlink) 0700 directory of the current user.
 */
export function desktopQueueDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DesktopQueueState {
  const raw = env.VLAD_DESKTOP_QUEUE?.trim();
  if (!raw || (platform !== "win32" && platform !== "darwin" && platform !== "linux")) return { dir: null };
  // a worker (VLAD_TASK_ID set) must not enqueue launches; fall back to the usual window (v2 contract)
  if (env.VLAD_TASK_ID?.trim()) return { dir: null };
  const isDir = (): boolean => { try { return statSync(raw).isDirectory(); } catch { return false; } };
  if (!isAbsolute(raw) || !isDir()) {
    return { dir: null, warning: `VLAD_DESKTOP_QUEUE kullanılamıyor (mutlak, var olan klasör değil): ${raw}; normal başlatmaya düşülüyor` };
  }
  if (platform !== "win32") {
    const bad = posixDirProblem(raw, false);
    if (bad) return { dir: null, warning: `VLAD_DESKTOP_QUEUE güvensiz (${bad}): ${raw}; normal başlatmaya düşülüyor` };
  }
  return { dir: raw };
}

/** Why `dir` is not a private directory of the current user ("symlink", "sahibi başka", "izinler gevşek: 755"), or null when it is. */
function posixDirProblem(dir: string, ignoreMode: boolean): string | null {
  let st;
  try { st = lstatSync(dir); } catch (e) { return (e as Error).message; }
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isDirectory()) return "klasör değil";
  if (process.getuid && st.uid !== process.getuid()) return "sahibi başka kullanıcı";
  if (!ignoreMode && (st.mode & 0o077) !== 0) return `izinler gevşek: ${(st.mode & 0o777).toString(8)}`;
  return null;
}

/** Atomically (temp name + rename) writes `<dir>/<taskId>.json`. Throws when the folder is not writable. */
export function enqueueDesktop(dir: string, req: Omit<DesktopQueueRequest, "v" | "createdAt" | "pid" | "scriptSha256"> & { createdAt?: string; pid?: number }): string {
  const scriptSha256 = createHash("sha256").update(readFileSync(req.script)).digest("hex");
  const body: DesktopQueueRequest = { v: 2, scriptSha256, createdAt: new Date().toISOString(), pid: process.pid, ...req };
  const file = join(dir, `${req.taskId}.json`);
  writeFileAtomic(file, JSON.stringify(body));
  return file;
}

/**
 * Creates `dir` and locks it to the current user (POSIX: 0700, no symlink) or, on Windows, to the current user + SYSTEM
 * (inheritance removed) via icacls; throws on failure
 * so the caller can fall back to the window path instead of queueing through an open folder.
 */
export function secureDir(dir: string): void {
  if (process.platform !== "win32") {
    // POSIX: our own folder, so tighten it to 0700 after refusing symlinks / foreign owners (chmod would follow a symlink)
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const bad = posixDirProblem(dir, true);
    if (bad) throw new Error(`${dir}: ${bad}`);
    chmodSync(dir, 0o700);
    return;
  }
  mkdirSync(dir, { recursive: true });
  // absolute System32 paths: PATH may put Git's coreutils whoami first
  const sys32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const icacls = (args: string[]): string => execFileSync(join(sys32, "icacls.exe"), args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const who = execFileSync(join(sys32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const m = /^"([^"]+)","(S-1-[\d-]+)"\s*$/.exec(who.trim());
  if (!m) throw new Error("kullanıcı SID'i okunamadı");
  const [, name, sid] = m;
  // allow-list, not an additive grant: /reset drops every explicit ACE (a pre-existing Everyone/other-user entry would survive /grant:r), /inheritance:r drops inherited ones
  icacls([dir, "/reset", "/T", "/C"]);
  icacls([dir, "/inheritance:r"]);
  icacls([dir, "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
  // verify: only the current user and SYSTEM may remain, none inherited
  const allowed = new Set([name.toLowerCase(), "nt authority\\system"]);
  // icacls prints `<path> <principal>:(flags)` for the first ACE and `<spaces><principal>:(flags)` for the rest
  const principals = icacls([dir]).split(/\r?\n/).filter((l) => /:\(/.test(l)).map((l) => {
    const head = l.slice(0, l.indexOf(":(")).trim();
    const who = head.startsWith(dir) ? head.slice(dir.length).trim() : head;
    return { line: l, who: who.toLowerCase() };
  });
  const extra = principals.filter((p) => !allowed.has(p.who) || /\(I\)/.test(p.line));
  if (principals.length === 0 || extra.length) throw new Error(`ACL doğrulaması başarısız: ${extra.map((p) => p.line.trim()).join("; ") || "ACE yok"}`);
}

/**
 * Wraps the external launcher: prepares the script like `--external`, then queues it for vlad-desktop. If the queue file
 * cannot be written, warns and falls back to `fallback` (the usual terminal window).
 */
export function queueLauncher(dir: string, kind: DesktopQueueRequest["kind"], fallback: Launcher, scriptDir?: string): Launcher {
  return {
    async launch(req: LaunchRequest): Promise<LaunchResult> {
      try {
        secureDir(scriptDir ?? join(tmpdir(), "vlad"));
      } catch (e) {
        process.stderr.write(`uyarı: betik klasörü korunamadı (${(e as Error).message}); kuyruk yazılamadı, dış pencere açılıyor
`);
        return fallback.launch(req);
      }
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
