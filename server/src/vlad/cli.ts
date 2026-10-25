import { execFile } from "node:child_process";
import { join } from "node:path";

/** Concurrent `vlad` child processes; further calls wait in line. */
export const MAX_CONCURRENT = 4;
export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export type VladErrorKind = "timeout" | "aborted" | "active_elsewhere" | "index_lock" | "push_failed" | "kb_busy" | "not_found" | "spawn" | "failed";

/** A failed `vlad` run. `kind` is the stable key callers branch on; `stderr` text is never shown to clients. */
export class VladError extends Error {
  readonly kind: VladErrorKind;
  readonly details: string[];

  constructor(kind: VladErrorKind, message: string, details: string[] = []) {
    super(message);
    this.name = "VladError";
    this.kind = kind;
    this.details = details;
  }
}

/** Maps the CLI's stderr (`{"error","details"}` JSON with --json, plain text otherwise) to an error kind. */
export function classifyVladError(stderr: string): { kind: VladErrorKind; message: string; details: string[] } {
  let message = stderr.trim();
  let details: string[] = [];
  try {
    const j = JSON.parse(message.split("\n").filter(Boolean).pop() ?? "");
    if (typeof j?.error === "string") {
      message = j.error;
      details = Array.isArray(j.details) ? j.details.map(String) : [];
    }
  } catch { /* plain text */ }
  const kind: VladErrorKind =
    message.startsWith("active_elsewhere") ? "active_elsewhere"
    : /index\.lock/.test(message) ? "index_lock"
    : /kb-meşgul|kart meşgul/.test(message) ? "kb_busy"
    : /push|rejected|non-fast-forward|could not read from remote/i.test(message) ? "push_failed"
    : /bulunamadı/.test(message) ? "not_found"
    : "failed";
  return { kind, message, details };
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Where the CLI lives and which kb it works on, read from the environment at call time: `VLAD_HOME`, `VLAD_KB_DIR`
 * and `VLAD_CLI` (path of the built cli.js; default `<VLAD_HOME>/dist/cli.js`).
 */
function target(): { cli: string; env: NodeJS.ProcessEnv } {
  const home = process.env.VLAD_HOME;
  if (!home) throw new VladError("spawn", "VLAD_HOME ayarlı değil");
  // Only what the CLI needs travels to the child: the kb location plus PATH/HOME for git. No other variable
  // (tokens, FCM keys, ...) leaks into it.
  const env: NodeJS.ProcessEnv = { VLAD_HOME: home };
  if (process.env.VLAD_KB_DIR) env.VLAD_KB_DIR = process.env.VLAD_KB_DIR;
  for (const k of ["PATH", "HOME"]) if (process.env[k]) env[k] = process.env[k];
  return { cli: process.env.VLAD_CLI || join(home, "dist", "cli.js"), env };
}

let running = 0;
const waiting: (() => void)[] = [];
const acquire = (): Promise<void> =>
  running < MAX_CONCURRENT ? (running++, Promise.resolve()) : new Promise((res) => waiting.push(res));
const release = () => {
  const next = waiting.shift();
  if (next) next(); // slot passes straight to the next waiter
  else running--;
};
/** Child processes alive right now (for tests). */
export const activeRuns = () => running;

/**
 * Runs `node <cli> ...args` without a shell (arguments are never parsed by one) and resolves with stdout.
 * Rejects with {@link VladError}: `timeout` (the child is SIGKILLed), `aborted`, or the kind classified from stderr.
 */
export async function runVlad(args: string[], opts: RunOptions = {}): Promise<string> {
  const { cli, env } = target();
  if (opts.signal?.aborted) throw new VladError("aborted", "iptal edildi");
  await acquire();
  try {
    if (opts.signal?.aborted) throw new VladError("aborted", "iptal edildi");
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath, [cli, ...args],
        { env, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER, signal: opts.signal, windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number; name?: string };
          if (e.name === "AbortError") return reject(new VladError("aborted", "iptal edildi"));
          if (e.killed) return reject(new VladError("timeout", `zaman aşımı: vlad ${args[0] ?? ""}`));
          if (typeof e.code === "string") return reject(new VladError("spawn", `vlad başlatılamadı: ${e.code}`));
          const c = classifyVladError(String(stderr));
          reject(new VladError(c.kind, c.message, c.details));
        },
      );
      child.stdin?.end();
    });
  } finally {
    release();
  }
}

/** `runVlad` with `--json` appended, stdout parsed. */
export async function runVladJson<T = unknown>(args: string[], opts?: RunOptions): Promise<T> {
  const out = await runVlad([...args, "--json"], opts);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new VladError("failed", `vlad ${args[0] ?? ""}: çıktı JSON değil`);
  }
}
