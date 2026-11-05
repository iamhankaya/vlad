import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SpawnOpts {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  /** default 30 000 */
  timeoutMs?: number;
  /** default 10 MB */
  maxBuffer?: number;
}

export interface SpawnResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** spawn failure or maxBuffer overflow (`ENOENT: …`, `ENOBUFS: …`); never thrown */
  spawnError?: string;
}

const CLI = join(import.meta.dirname, "..", "..", "dist", "cli.js");

/** Config-provided guards that every spawned CLI keeps (vitest.config.ts env); the rest of the shell is not inherited. */
const GUARDS = ["VLAD_LAUNCHER", "VLAD_NO_NATIVE", "VLAD_CLAUDE_JSON", "CLAUDE_CODE_REMOTE"] as const;
// Windows needs these to start a process at all
const OS_BASE = ["SYSTEMROOT", "COMSPEC", "PATHEXT", "TMPDIR", "TEMP", "TMP"] as const;

let tempHome: string | undefined;
function defaultHome(): string {
  if (!tempHome) {
    tempHome = mkdtempSync(join(tmpdir(), "vlad-spawn-home-"));
    const dir = tempHome;
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return tempHome;
}

/**
 * Allowlist env for spawned CLIs: PATH (Windows `Path` normalized), OS basics, a temp HOME and the config guards,
 * plus whatever the test passes. Never spreads process.env, so the developer shell (VLAD_ variables, tokens) cannot leak in.
 */
export function isolatedEnv(base: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const path = process.env.PATH ?? process.env.Path;
  if (path !== undefined) env.PATH = path;
  for (const k of OS_BASE) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  for (const k of GUARDS) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  const home = defaultHome();
  env.HOME = home;
  env.USERPROFILE = home;
  const { Path: _p, ...rest } = base;
  return { ...env, ...rest };
}

/** spawnSync with a hard SIGKILL timeout; timeouts, spawn errors and buffer overflows land in the result. */
export function runSpawn(file: string, argv: string[], o: Omit<SpawnOpts, "args"> = {}): SpawnResult {
  const r = spawnSync(file, argv, {
    cwd: o.cwd,
    env: isolatedEnv(o.env),
    input: o.input,
    encoding: "utf8",
    timeout: o.timeoutMs ?? 30_000,
    killSignal: "SIGKILL",
    maxBuffer: o.maxBuffer ?? 10 * 1024 * 1024,
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut: code === "ETIMEDOUT",
    spawnError: r.error && code !== "ETIMEDOUT" ? `${code ?? "ERR"}: ${r.error.message}` : undefined,
  };
}

/** Runs `node dist/cli.js <args>` (build first: global-setup does). */
export function spawnVlad(o: SpawnOpts): SpawnResult {
  const { args, ...rest } = o;
  return runSpawn(process.execPath, [CLI, ...args], rest);
}
