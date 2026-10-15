import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRequest, LaunchResult, Launcher } from "./types.js";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function buildScript(req: LaunchRequest): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(req.env)) lines.push(`$env:${k} = ${q(v)}`);
  lines.push(`Set-Location -LiteralPath ${q(req.cwd)}`);
  lines.push(`$host.UI.RawUI.WindowTitle = ${q(req.title)}`);
  // Here-string terminator must sit at column 0, so protect prompt lines that start with '@.
  const prompt = req.prompt
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => (l.startsWith("'@") ? " " + l : l))
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
      file: "wt",
      args: ["-w", "0", "nt", "--title", req.title, "-d", req.cwd, "powershell", "-NoExit",
        "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    };
  }
  return {
    file: "powershell",
    args: ["-NoProfile", "-Command",
      `Start-Process powershell -WorkingDirectory ${q(req.cwd)} -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File',${q(scriptPath)}`],
  };
}

function defaultHasWt(): boolean {
  try {
    execFileSync("where.exe", ["wt"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function defaultExec(file: string, args: string[]): void {
  spawn(file, args, { detached: true, stdio: "ignore" }).unref();
}

export class TerminalLauncher implements Launcher {
  constructor(private o: {
    mode: "auto" | "wt" | "powershell";
    dryRun?: boolean;
    hasWt?: () => boolean;
    exec?: (file: string, args: string[]) => void;
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
      (this.o.exec ?? defaultExec)(cmd.file, cmd.args);
      return { ok: true, method, detail: JSON.stringify(cmd) };
    } catch (e) {
      return { ok: false, method, detail: (e as Error).message };
    }
  }
}
