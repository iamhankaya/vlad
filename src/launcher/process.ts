import { execFile, execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentMachine } from "../kb/machine.js";
import { kbPaths } from "../kb/home.js";
import { SESSION_ID } from "./stream.js";
import { MODEL } from "./terminal.js";
import type { LaunchRequest, LaunchResult, Launcher } from "./types.js";

/** Only these variables reach the worker (F-vlad-007: clean environment); nothing else of ours is inherited. */
export const WORKER_ENV_KEYS = ["PATH", "HOME", "VLAD_HOME", "VLAD_TASK_ID", "VLAD_MACHINE"] as const;
/** Same as the task schema's `id`; the id lands in a unit name and file names. */
const TASK_ID = /^T\d{8}-\d{2,}$/;

/** POSIX single-quoting: everything is literal inside '...' except the quote itself. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const unitName = (taskId: string): string => `vlad-worker-${taskId}`;

/** deploy/claude/worker-settings.json next to the package (src/launcher and dist/launcher are both two levels deep). */
export const defaultSettingsPath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "claude", "worker-settings.json");

/** Worker environment: the fixed key list only, values from the request, then ours. Shared by --setenv and `env -i`. */
export function workerEnv(req: LaunchRequest, env: NodeJS.ProcessEnv = process.env): [string, string][] {
  if (!TASK_ID.test(req.taskId)) throw new Error(`geçersiz görev kimliği: ${JSON.stringify(req.taskId)}`);
  const vals: Record<string, string | undefined> = {
    PATH: env.PATH, HOME: env.HOME, VLAD_HOME: env.VLAD_HOME, ...req.env, VLAD_TASK_ID: req.taskId, VLAD_MACHINE: currentMachine(env),
  };
  const pairs: [string, string][] = [];
  for (const k of WORKER_ENV_KEYS) {
    const v = vals[k];
    if (v === undefined || v === "") continue;
    if (/[\0\r\n]/.test(v)) throw new Error(`ortam değişkeni değeri geçersiz karakter içeriyor: ${k}`);
    pairs.push([k, v]);
  }
  return pairs;
}

/**
 * The prompt is read from a file on stdin, never put in argv, so its size does not hit ARG_MAX.
 * `env -i` drops whatever the systemd user manager hands down; only the fixed list reaches claude.
 * Only the --settings file is loaded (no project/local settings, no project .mcp.json) so a worktree
 * cannot weaken the allow/deny net.
 */
export function buildShellScript(
  req: LaunchRequest, promptPath: string, settingsPath: string, env: NodeJS.ProcessEnv = process.env,
): string {
  if (req.model !== undefined && !MODEL.test(req.model)) throw new Error(`geçersiz model: ${JSON.stringify(req.model)}`);
  const vars = workerEnv(req, env).map(([k, v]) => shq(`${k}=${v}`));
  const claude = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "auto",
    "--setting-sources", "user", "--strict-mcp-config", "--settings", shq(settingsPath)];
  if (req.model !== undefined) claude.push("--model", shq(req.model));
  if (req.resumeSessionId !== undefined) {
    if (!SESSION_ID.test(req.resumeSessionId)) throw new Error(`geçersiz session_id: ${JSON.stringify(req.resumeSessionId)}`);
    claude.push("--resume", shq(req.resumeSessionId));
  }
  const run = `env -i ${vars.join(" ")} ${claude.join(" ")} < ${shq(promptPath)}`;
  const head = ["#!/bin/sh", `cd ${shq(req.cwd)} || exit 1`];
  if (!req.tap) return [...head, `exec ${run}`].join("\n") + "\n";
  // the pipe replaces exec: claude's exit code goes to the journal
  // the tap runs under the same clean env, called by absolute path (no PATH lookup of `vlad`)
  const tap = `env -i ${vars.join(" ")} ${shq(process.execPath)} ${shq(cliPath())} worker tap ${shq(req.taskId)}`;
  return [...head, `{ ${run}; echo "claude exit $?" >&2; } | ${tap}`].join("\n") + "\n";
}

/** The CLI entry next to the package (src/launcher and dist/launcher are both two levels below the root; built: dist/cli.js). */
const cliPath = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

/** Per-user state dir for scripts, prompts and settings copies: $XDG_RUNTIME_DIR/vlad or ~/.local/state/vlad. */
export function workerDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "vlad");
  if (env.HOME) return join(env.HOME, ".local", "state", "vlad");
  throw new Error("çalışan klasörü belirlenemedi: XDG_RUNTIME_DIR ve HOME yok");
}

/** Creates the dir 0700 if missing; then refuses anything but our own real 0700 directory (no symlink, no shared /tmp). */
export function ensureWorkerDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`çalışan klasörü güvenli değil (dizin değil ya da symlink): ${dir}`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`çalışan klasörü başka kullanıcıya ait: ${dir}`);
  if ((st.mode & 0o077) !== 0) throw new Error(`çalışan klasörü 0700 değil: ${dir}`);
}

/** Writes a fresh 0600 file: any old one is removed first, then O_EXCL|O_NOFOLLOW so nothing planted can be followed. */
export function writeSecureFile(path: string, data: string, mode = 0o600): void {
  rmSync(path, { force: true });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeSync(fd, data); } finally { closeSync(fd); }
}

/**
 * User-owned copy of worker-settings.json for this launch, with the package's deploy dir and the
 * runtime dir added to the Edit/Write deny list (absolute paths need the `//` prefix). `protect` adds more
 * (VLAD_HOME and its kb/: tasks, quota marker and VLAD's own code are not for a worker to edit).
 */
export function renderSettings(settingsPath: string, dir: string, protect: string[] = []): string {
  const s = JSON.parse(readFileSync(settingsPath, "utf8")) as { permissions?: { deny?: string[] } };
  const deny = s.permissions?.deny ?? [];
  for (const p of [resolve(dirname(settingsPath)), resolve(dir), ...protect.map((x) => resolve(x))]) {
    for (const tool of ["Edit", "Write"]) deny.push(`${tool}(/${p}/**)`);
  }
  s.permissions = { ...s.permissions, deny };
  return JSON.stringify(s, null, 2) + "\n";
}

export function buildSystemdArgs(req: LaunchRequest, scriptPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const setenv = workerEnv(req, env).map(([k, v]) => `--setenv=${k}=${v}`);
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
      const dir = this.o.scriptDir ?? workerDir(env);
      const scriptPath = join(dir, `${req.taskId}.sh`);
      const promptPath = join(dir, `${req.taskId}.prompt`);
      const settingsSrc = this.o.settingsPath ?? defaultSettingsPath();
      const settingsPath = join(dir, `${req.taskId}.settings.json`);
      const script = buildShellScript(req, promptPath, settingsPath, env);
      const cmd = { file: "systemd-run", args: buildSystemdArgs(req, scriptPath, env) };
      if (this.o.dryRun) return { ok: true, method: "process", detail: JSON.stringify(cmd) };
      // the settings file is the allow/deny net around the worker; refuse to start without it
      if (!existsSync(settingsSrc)) throw new Error(`worker-settings.json bulunamadı: ${settingsSrc}`);
      const home = req.env.VLAD_HOME ?? env.VLAD_HOME ?? kbPaths().home;
      const settings = renderSettings(settingsSrc, dir, [home, kbPaths(home).kb]);
      ensureWorkerDir(dir);
      writeSecureFile(promptPath, req.prompt);
      writeSecureFile(settingsPath, settings);
      writeSecureFile(scriptPath, script, 0o700);
      await (this.o.exec ?? defaultExec)(cmd.file, cmd.args);
      return { ok: true, method: "process", detail: JSON.stringify(cmd) };
    } catch (e) {
      return { ok: false, method: "process", detail: (e as Error).message };
    }
  }
}

/** Stops the task's unit and everything in its cgroup, then removes its launch files. A unit that is not running is not an error. */
export function closeWorkerProcess(
  taskId: string,
  run: (file: string, args: string[]) => void = (f, a) => {
    try { execFileSync(f, a, { stdio: "ignore", timeout: 20000 }); } catch { /* not loaded / no systemd: nothing to stop */ }
  },
  dir?: string,
): void {
  if (!TASK_ID.test(taskId)) throw new Error(`geçersiz görev kimliği: ${JSON.stringify(taskId)}`);
  run("systemctl", ["--user", "stop", `${unitName(taskId)}.service`]);
  // the prompt carries task content; remove it and the other per-launch files with the worker
  let d: string;
  try { d = dir ?? workerDir(); } catch { return; }
  for (const ext of ["sh", "prompt", "settings.json"]) rmSync(join(d, `${taskId}.${ext}`), { force: true });
}
