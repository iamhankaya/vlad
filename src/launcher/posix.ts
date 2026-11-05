import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertRealLauncherAllowed } from "./mode.js";
import type { LaunchRequest, LaunchResult, Launcher } from "./types.js";

// Same patterns as terminal.ts; the values land in a shell script.
const AUTOCOMPACT = /^\d+(\.\d+)?[kKmM]?$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** macOS/Linux counterpart of buildScript: same env, prompt, model/autocompact/resume flags, as a bash script. */
export function buildPosixScript(req: LaunchRequest): string {
  if (req.model !== undefined && !MODEL.test(req.model)) throw new Error(`geçersiz model: ${JSON.stringify(req.model)}`);
  if (req.autoCompact !== undefined && !AUTOCOMPACT.test(req.autoCompact)) throw new Error(`geçersiz autoCompact: ${JSON.stringify(req.autoCompact)}`);
  const lines = ["#!/usr/bin/env bash"];
  for (const [k, v] of Object.entries(req.env)) {
    if (!ENV_NAME.test(k)) throw new Error(`geçersiz env adı: ${JSON.stringify(k)}`);
    lines.push(`export ${k}=${q(v)}`);
  }
  lines.push(`cd ${q(req.cwd)} || exit 1`, `printf '\\033]0;%s\\007' ${q(req.title.replace(/[\x00-\x1f\x7f]/g, " "))}`);
  const prompt = req.prompt.replace(/\r\n?/g, "\n");
  let eof = "VLAD_PROMPT_EOF";
  while (prompt.split("\n").includes(eof)) eof += "_";
  // read, not $(cat <<EOF): bash 3.2 (macOS /bin/bash) parses a heredoc body inside $( ) and chokes on quotes/parens
  lines.push(`IFS= read -r -d '' p <<'${eof}'`, prompt, eof, "p=${p%$'\\n'}");
  const flags = [
    ...(req.model === undefined ? [] : ["--model", q(req.model)]),
    ...(req.autoCompact === undefined ? [] : ["--autocompact", q(req.autoCompact)]),
    ...(req.resume ? (req.resume.sessionId ? ["--resume", q(req.resume.sessionId)] : ["--continue"]) : []),
  ];
  lines.push(["claude", ...flags, '"$p"'].join(" "));
  return lines.join("\n") + "\n";
}

export const tmuxSession = (taskId: string): string => `vlad-${taskId}`;

export function buildTmuxArgs(req: LaunchRequest, scriptPath: string): string[] {
  return ["new-session", "-d", "-s", tmuxSession(req.taskId), "-c", req.cwd, `bash ${q(scriptPath)}`];
}

export function buildTerminalAppArgs(scriptPath: string): string[] {
  const cmd = `bash ${q(scriptPath)}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return ["-e", 'tell application "Terminal" to activate', "-e", `tell application "Terminal" to do script "${cmd}"`];
}

/** Command line for `--external` on POSIX: the script path is double-quoted only when it needs it. */
export const posixCommand = (script: string): string =>
  `bash ${/[^\w@%+=:,./-]/.test(script) ? `"${script.replace(/(["\\$`])/g, "\\$1")}"` : script}`;

export function externalPosixLaunch(req: LaunchRequest, scriptDir?: string): LaunchResult {
  const dir = scriptDir ?? join(tmpdir(), "vlad");
  const script = join(dir, `${req.taskId}.sh`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(script, buildPosixScript(req), { encoding: "utf8", mode: 0o755 });
  } catch (e) {
    return { ok: false, method: "external", detail: (e as Error).message };
  }
  const command = posixCommand(script);
  return { ok: true, method: "external", script, command, cwd: req.cwd, detail: command };
}

function defaultRun(file: string, args: string[]): Promise<void> {
  assertRealLauncherAllowed();
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 20000 }, (err, _o, stderr) =>
      err ? reject(new Error(String(stderr).trim() || err.message)) : resolve()));
}

function defaultHasTmux(): boolean {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
}

export class PosixLauncher implements Launcher {
  constructor(private o: {
    mode: "tmux" | "terminal";
    dryRun?: boolean;
    hasTmux?: () => boolean;
    run?: (file: string, args: string[]) => void | Promise<void>;
    scriptDir?: string;
  }) {}

  async launch(req: LaunchRequest): Promise<LaunchResult> {
    const method = this.o.mode;
    const scriptPath = join(this.o.scriptDir ?? join(tmpdir(), "vlad"), `${req.taskId}.sh`);
    const cmd = method === "tmux"
      ? { file: "tmux", args: buildTmuxArgs(req, scriptPath) }
      : { file: "osascript", args: buildTerminalAppArgs(scriptPath) };
    if (this.o.dryRun) return { ok: true, method, detail: JSON.stringify(cmd) };
    if (method === "tmux" && !(this.o.hasTmux ?? defaultHasTmux)()) {
      return { ok: false, method, detail: "tmux bulunamadı; kur: brew install tmux (Linux: paket yöneticisiyle tmux)" };
    }
    try {
      mkdirSync(dirname(scriptPath), { recursive: true });
      writeFileSync(scriptPath, buildPosixScript(req), { encoding: "utf8", mode: 0o755 });
      await (this.o.run ?? defaultRun)(cmd.file, cmd.args);
      return { ok: true, method, detail: JSON.stringify(cmd) };
    } catch (e) {
      const m = (e as Error).message;
      return { ok: false, method, detail: /duplicate session/.test(m) ? `${m} (önce: vlad task close-window ${req.taskId})` : m };
    }
  }
}

/**
 * Closes a task's worker on macOS/Linux: kills the tmux session, then any process whose command line names
 * `/vlad/<id>.sh` (Terminal.app mode) with its direct children (claude). Returns the killed script PIDs.
 */
export function closePosixWorker(
  taskId: string,
  o: {
    run?: (file: string, args: string[]) => string | void;
    kill?: (pid: number) => void;
    selfPid?: number;
  } = {},
): number[] {
  // Throw up front: the per-call guard below sits inside try/catch blocks and would be swallowed (F-vlad-064).
  if (!o.run) assertRealLauncherAllowed();
  const run = o.run ?? ((f: string, a: string[]) => {
    assertRealLauncherAllowed();
    return execFileSync(f, a, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
  });
  const kill = o.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  const self = o.selfPid ?? process.pid;
  try { run("tmux", ["kill-session", "-t", tmuxSession(taskId)]); } catch { /* no session or no tmux */ }
  let found = "";
  try { found = String(run("pgrep", ["-f", "--", `bash .*/vlad/${taskId.replace(/[^\w-]/g, "\\$&")}\\.sh$`]) ?? ""); } catch { /* pgrep exits 1 on no match */ }
  const killed: number[] = [];
  for (const pid of found.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => n > 0 && n !== self && n !== process.ppid)) {
    try { run("pkill", ["-TERM", "-P", String(pid)]); } catch { /* no children */ }
    try { kill(pid); killed.push(pid); } catch { /* already gone */ }
  }
  return killed;
}
