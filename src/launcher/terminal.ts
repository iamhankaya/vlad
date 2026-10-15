import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRequest, LaunchResult, Launcher } from "./types.js";

// PowerShell treats typographic single quotes as quote characters too; double each one.
const SQ = /['‘’‚‛]/g;
const q = (s: string) => `'${s.replace(SQ, (m) => m + m)}'`;

export function buildScript(req: LaunchRequest): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(req.env)) lines.push(`$env:${k} = ${q(v)}`);
  lines.push(`Set-Location -LiteralPath ${q(req.cwd)}`);
  lines.push(`$host.UI.RawUI.WindowTitle = ${q(req.title)}`);
  // Here-string terminator must sit at column 0, so protect prompt lines that start with '@.
  const prompt = req.prompt
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => (/^['‘’‚‛]@/.test(l) ? " " + l : l))
    .join("\n");
  lines.push("$p = @'", prompt, "'@");
  lines.push("claude $p");
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

/** Closes the terminal of a task's worker (Windows only). Returns the killed process IDs. */
export function closeWorkerWindow(taskId: string): number[] {
  if (process.platform !== "win32") return [];
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", KILL_WORKER], {
    encoding: "utf8", windowsHide: true, timeout: 20000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, VLAD_WORKER_SCRIPT: `\\vlad\\${taskId}.ps1`.toLowerCase() },
  });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(Number);
}

export class TerminalLauncher implements Launcher {
  constructor(private o: {
    mode: "auto" | "wt" | "powershell";
    dryRun?: boolean;
    hasWt?: () => boolean;
    exec?: (file: string, args: string[], cwd?: string) => void | Promise<void>;
    scriptDir?: string;
  }) {}

  async launch(req: LaunchRequest): Promise<LaunchResult> {
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
