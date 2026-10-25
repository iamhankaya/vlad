import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentMachine } from "../kb/machine.js";
import { MODEL } from "./terminal.js";
import type { LaunchRequest, LaunchResult, Launcher } from "./types.js";

/** Only these variables reach the worker (F-vlad-007: clean environment); nothing else of ours is inherited. */
export const WORKER_ENV_KEYS = ["PATH", "HOME", "VLAD_HOME", "VLAD_TASK_ID", "VLAD_MACHINE"] as const;
const TASK_ID = /^[A-Za-z0-9._-]+$/;

/** POSIX single-quoting: everything is literal inside '...' except the quote itself. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const unitName = (taskId: string): string => `vlad-worker-${taskId}`;

/** deploy/claude/worker-settings.json next to the package (src/launcher and dist/launcher are both two levels deep). */
export const defaultSettingsPath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "claude", "worker-settings.json");

/** The prompt is read from a file on stdin, never put in argv, so its size does not hit ARG_MAX. */
export function buildShellScript(req: LaunchRequest, promptPath: string, settingsPath: string): string {
  if (req.model !== undefined && !MODEL.test(req.model)) throw new Error(`geçersiz model: ${JSON.stringify(req.model)}`);
  const claude = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--settings", shq(settingsPath)];
  if (req.model !== undefined) claude.push("--model", shq(req.model));
  return ["#!/bin/sh", `cd ${shq(req.cwd)} || exit 1`, `exec ${claude.join(" ")} < ${shq(promptPath)}`].join("\n") + "\n";
}

export function buildSystemdArgs(req: LaunchRequest, scriptPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!TASK_ID.test(req.taskId)) throw new Error(`geçersiz görev kimliği: ${JSON.stringify(req.taskId)}`);
  const vals: Record<string, string | undefined> = {
    PATH: env.PATH, HOME: env.HOME, ...req.env, VLAD_TASK_ID: req.taskId, VLAD_MACHINE: currentMachine(env),
  };
  const setenv: string[] = [];
  for (const k of WORKER_ENV_KEYS) {
    const v = vals[k] ?? (k === "VLAD_HOME" ? env.VLAD_HOME : undefined);
    if (v === undefined || v === "") continue;
    if (/[\0\r\n]/.test(v)) throw new Error(`ortam değişkeni değeri geçersiz karakter içeriyor: ${k}`);
    setenv.push(`--setenv=${k}=${v}`);
  }
  return [
    "--user", "--collect", `--unit=${unitName(req.taskId)}`, `--description=${req.title.replace(/[\0\r\n]/g, " ")}`,
    "-p", "KillMode=control-group", `--working-directory=${req.cwd}`, ...setenv, "--", "/bin/sh", scriptPath,
  ];
}

function defaultExec(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20000 }, (err, _o, stderr) => {
      if (!err) return resolve();
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reject(new Error("systemd-run bulunamadı: Linux sunucuda systemd (kullanıcı oturumu) gerekli"));
      }
      reject(new Error(`systemd-run başarısız: ${String(stderr || err.message).trim()}`));
    });
  });
}

/** Linux worker: a transient systemd user unit (`vlad-worker-<id>`) running `claude -p` headless. */
export class ProcessLauncher implements Launcher {
  constructor(private o: {
    dryRun?: boolean;
    exec?: (file: string, args: string[]) => void | Promise<void>;
    scriptDir?: string;
    settingsPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {}) {}

  async launch(req: LaunchRequest): Promise<LaunchResult> {
    const env = this.o.env ?? process.env;
    try {
      const dir = this.o.scriptDir ?? join(env.XDG_RUNTIME_DIR || tmpdir(), "vlad");
      const scriptPath = join(dir, `${req.taskId}.sh`);
      const promptPath = join(dir, `${req.taskId}.prompt`);
      const settingsPath = this.o.settingsPath ?? defaultSettingsPath();
      const script = buildShellScript(req, promptPath, settingsPath);
      const cmd = { file: "systemd-run", args: buildSystemdArgs(req, scriptPath, env) };
      if (this.o.dryRun) return { ok: true, method: "process", detail: JSON.stringify(cmd) };
      // the settings file is the allow/deny net around the worker; refuse to start without it
      if (!existsSync(settingsPath)) throw new Error(`worker-settings.json bulunamadı: ${settingsPath}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(promptPath, req.prompt, { mode: 0o600 });
      writeFileSync(scriptPath, script, { mode: 0o700 });
      await (this.o.exec ?? defaultExec)(cmd.file, cmd.args);
      return { ok: true, method: "process", detail: JSON.stringify(cmd) };
    } catch (e) {
      return { ok: false, method: "process", detail: (e as Error).message };
    }
  }
}

/** Stops the task's unit and everything in its cgroup. A unit that is not running is not an error. */
export function closeWorkerProcess(
  taskId: string,
  run: (file: string, args: string[]) => void = (f, a) => {
    try { execFileSync(f, a, { stdio: "ignore", timeout: 20000 }); } catch { /* not loaded / no systemd: nothing to stop */ }
  },
): void {
  if (!TASK_ID.test(taskId)) throw new Error(`geçersiz görev kimliği: ${JSON.stringify(taskId)}`);
  run("systemctl", ["--user", "stop", `${unitName(taskId)}.service`]);
}
