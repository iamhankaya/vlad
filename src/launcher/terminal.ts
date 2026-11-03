import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRealLauncherAllowed } from "./mode.js";
import { closePosixWorker, externalPosixLaunch } from "./posix.js";
import type { LaunchRequest, LaunchResult, Launcher } from "./types.js";

// PowerShell treats typographic single quotes as quote characters too; double each one.
const SQ = /['‘’‚‛]/g;
const q = (s: string) => `'${s.replace(SQ, (m) => m + m)}'`;
// Same as the role schema's `model` pattern; checked again here because the value lands in a script.
const AUTOCOMPACT = /^\d+(\.\d+)?[kKmM]?$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/;

// Windows PowerShell 5.1 (and pwsh < 7.3) pass a native argument without escaping embedded double quotes, so the
// argument ended at the first `"` (T20261103-26). Apply the CommandLineToArgvW rules by hand there: backslashes before
// a quote are doubled and the quote escaped, trailing backslashes are doubled (the argument is quoted for its spaces).
const PS51_ARG_ESCAPE =
  // Legacy pins the argument mode (pwsh >= 7.3 would otherwise escape on its own, or not at all for .cmd shims / a profile setting)
  "$PSNativeCommandArgumentPassing = 'Legacy'; " +
  "$p = [regex]::Replace($p, '(\\\\*)\"', '$1$1\\\"'); $p = [regex]::Replace($p, '(\\\\+)\\z', '$1$1')";
// CreateProcess limit is 32767 chars for the whole command line; leave room for the executable and flags.
const MAX_ARG = 30000;

export function buildScript(req: LaunchRequest): string {
  // the worker must not inherit the desktop queue (v2 contract: it would otherwise enqueue its own launches)
  const lines: string[] = ["Remove-Item Env:VLAD_DESKTOP_QUEUE -ErrorAction SilentlyContinue"];
  for (const [k, v] of Object.entries(req.env)) lines.push(`$env:${k} = ${q(v)}`);
  lines.push(`Set-Location -LiteralPath ${q(req.cwd)}`);
  lines.push(`$host.UI.RawUI.WindowTitle = ${q(req.title)}`);
  // Base64, not a here-string: no prompt text (quotes, `'@` at line start, `$`, backticks) can end or alter the literal.
  const prompt = Buffer.from(req.prompt.replace(/\r\n?/g, "\n"), "utf8").toString("base64");
  const escaped = req.prompt.replace(/(\\*)"/g, "$1$1\\\"");
  if (escaped.length > MAX_ARG) throw new Error(`prompt çok uzun (${escaped.length} > ${MAX_ARG} karakter): Windows komut satırı sınırı`);
  lines.push(`$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${prompt}'))`, PS51_ARG_ESCAPE);
  if (req.model !== undefined && !MODEL.test(req.model)) throw new Error(`geçersiz model: ${JSON.stringify(req.model)}`);
  if (req.autoCompact !== undefined && !AUTOCOMPACT.test(req.autoCompact)) throw new Error(`geçersiz autoCompact: ${JSON.stringify(req.autoCompact)}`);
  const flags = [
    ...(req.model === undefined ? [] : ["--model", q(req.model)]),
    ...(req.autoCompact === undefined ? [] : ["--autocompact", q(req.autoCompact)]),
    ...(req.resume ? (req.resume.sessionId ? ["--resume", q(req.resume.sessionId)] : ["--continue"]) : []),
  ];
  lines.push(["claude", ...flags, "$p"].join(" "));
  return lines.join("\n") + "\n";
}

export function buildCommand(
  req: LaunchRequest, method: "wt" | "powershell", scriptPath: string,
): { file: string; args: string[] } {
  if (method === "wt") {
    return {
      file: "wt.exe",
      args: ["-w", "0", "nt", "--title", req.title.replace(/;/g, "\\;"), "-d", req.cwd, "powershell", "-NoExit",
        "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    };
  }
  return { file: "powershell.exe", args: ["-NoExit", "-ExecutionPolicy", "Bypass", "-File", scriptPath] };
}

/** Joins file + args into one Windows command line (CommandLineToArgvW quoting rules). */
export function toCommandLine(file: string, args: string[]): string {
  const quote = (a: string) => {
    if (a !== "" && !/[\s"]/.test(a)) return a;
    // Backslashes are literal unless they precede a quote; double those, and the run before the closing quote.
    return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  };
  return [file, ...args].map(quote).join(" ");
}

function defaultHasWt(): boolean {
  try {
    execFileSync("where.exe", ["wt"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Claude Code runs shell commands in a Windows job object that kills every child process when the
// command returns, so the terminal is created through WMI (Win32_Process.Create), which starts it
// outside the job. Command line and cwd travel in env vars to avoid nested quoting.
const WMI_CREATE =
  "$a = @{ CommandLine = $env:VLAD_LAUNCH_CMD }; " +
  "if ($env:VLAD_LAUNCH_CWD) { $a.CurrentDirectory = $env:VLAD_LAUNCH_CWD }; " +
  "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $a; " +
  "exit [int]$r.ReturnValue";

export function defaultExec(file: string, args: string[], cwd?: string): Promise<void> {
  try { assertRealLauncherAllowed(); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WMI_CREATE],
      { windowsHide: true, timeout: 20000, env: { ...process.env, VLAD_LAUNCH_CMD: toCommandLine(file, args), VLAD_LAUNCH_CWD: cwd ?? "" } },
      (err) => {
        if (!err) return resolve();
        const code = (err as { code?: unknown }).code;
        reject(new Error(typeof code === "number"
          ? `Win32_Process.Create başarısız (kod ${code}). Kod 8 genellikle komut Claude Code'un Bash aracından ` +
            `çalıştırıldığında olur; vlad task launch'u PowerShell aracıyla tekrar çalıştır.`
          : err.message));
      },
    );
  });
}

// Finds the worker by the `\vlad\<id>.ps1` script on its command line (the same in wt and powershell
// mode) and kills it with its children (claude). The pattern travels in an env var so that this
// query's own command line does not match.
const KILL_WORKER =
  "$pat = $env:VLAD_WORKER_SCRIPT; " +
  "Get-CimInstance Win32_Process | " +
  "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($pat) } | " +
  "ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F | Out-Null; $_.ProcessId }";

/** Closes the terminal of a task's worker (Windows: process tree; macOS/Linux: tmux session + script processes). Returns the killed process IDs. */
export function closeWorkerWindow(taskId: string, platform: NodeJS.Platform = process.platform): number[] {
  if (platform === "darwin" || platform === "linux") return closePosixWorker(taskId);
  if (platform !== "win32") return [];
  assertRealLauncherAllowed();
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", KILL_WORKER], {
    encoding: "utf8", windowsHide: true, timeout: 20000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, VLAD_WORKER_SCRIPT: `\\vlad\\${taskId}.ps1`.toLowerCase() },
  });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(Number);
}

/** Starts nothing; used while VLAD_LAUNCHER=noop so tests can drive the launch flow without a terminal. */
export class NoopLauncher implements Launcher {
  async launch(req?: LaunchRequest): Promise<LaunchResult> {
    // test seam (T20261101-19): VLAD_NOOP_LOG gets one JSONL line per launch so tests can see what a remote worker would have started
    const log = process.env.VLAD_NOOP_LOG;
    if (log && req) appendFileSync(log, JSON.stringify({ taskId: req.taskId, cwd: req.cwd, title: req.title }) + String.fromCharCode(10));
    // test seam (F-vlad-102): simulates a slow terminal so tests can check what the launch holds meanwhile
    const delay = Number(process.env.VLAD_NOOP_LAUNCH_DELAY_MS);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return { ok: true, method: "noop", detail: "VLAD_LAUNCHER=noop" };
  }
}

/**
 * Embedded mode (vlad-desktop): writes `<tmp>/vlad/<id>.ps1` and returns how to run it; opens nothing, so the
 * noop guard does not apply. The file name stays `\vlad\<id>.ps1` (closeWorkerWindow and liveness match on it).
 */
export function externalLaunch(req: LaunchRequest, scriptDir?: string, platform: NodeJS.Platform = process.platform): LaunchResult {
  if (platform === "darwin" || platform === "linux") return externalPosixLaunch(req, scriptDir);
  const dir = scriptDir ?? join(tmpdir(), "vlad");
  const script = join(dir, `${req.taskId}.ps1`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(script, "﻿" + buildScript(req), "utf8");
  } catch (e) {
    return { ok: false, method: "external", detail: (e as Error).message };
  }
  const command = toCommandLine("powershell", ["-NoExit", "-ExecutionPolicy", "Bypass", "-File", script]);
  return { ok: true, method: "external", script, command, cwd: req.cwd, detail: command };
}

export class TerminalLauncher implements Launcher {
  constructor(private o: {
    mode: "auto" | "wt" | "powershell";
    dryRun?: boolean;
    external?: boolean;
    hasWt?: () => boolean;
    exec?: (file: string, args: string[], cwd?: string) => void | Promise<void>;
    scriptDir?: string;
  }) {}

  async launch(req: LaunchRequest): Promise<LaunchResult> {
    if (this.o.external) return externalLaunch(req, this.o.scriptDir);
    const method: "wt" | "powershell" =
      this.o.mode === "auto" ? ((this.o.hasWt ?? defaultHasWt)() ? "wt" : "powershell") : this.o.mode;
    const dir = this.o.scriptDir ?? join(tmpdir(), "vlad");
    const scriptPath = join(dir, `${req.taskId}.ps1`);
    const cmd = buildCommand(req, method, scriptPath);
    if (this.o.dryRun) return { ok: true, method, detail: JSON.stringify(cmd) };
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(scriptPath, "﻿" + buildScript(req), "utf8");
      await (this.o.exec ?? defaultExec)(cmd.file, cmd.args, req.cwd);
      return { ok: true, method, detail: JSON.stringify(cmd) };
    } catch (e) {
      return { ok: false, method, detail: (e as Error).message };
    }
  }
}
