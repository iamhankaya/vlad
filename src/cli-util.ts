import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { TRANSITIONS, TransitionError } from "./tasks/index.js";
import type { Task } from "./tasks/index.js";
import { ValidationError, withKbLock } from "./kb/index.js";
import { activeGuard, type GuardMode } from "./active/index.js";

export interface Opts { json?: boolean; [k: string]: unknown }

export const wantsJson = () => process.argv.includes("--json");

export function fail(e: unknown): never {
  let error = e instanceof Error ? e.message : String(e);
  let details: string[] = [];
  if (e instanceof ValidationError) details = e.details;
  else if (e instanceof TransitionError) details = [`izin verilenler: ${TRANSITIONS[e.from].join(", ") || "(yok)"}`];
  if (wantsJson()) process.stderr.write(JSON.stringify({ error, details }) + "\n");
  else {
    error = `hata: ${error}`;
    process.stderr.write([error, ...details.map((d) => `  ${d}`)].join("\n") + "\n");
  }
  process.exit(1);
}

/** Reads a file; "-" means stdin. */
export function readInput(p: string): string {
  return readFileSync(p === "-" ? 0 : p, "utf8");
}

export function out(o: Opts, data: unknown, text: string): void {
  process.stdout.write((o.json ? JSON.stringify(data) : text) + "\n");
}

export const taskLine = (t: Task) => `${t.data.id}  ${t.data.state.padEnd(17)} ${t.data.project}  ${t.data.title}`;

/** Registers a command with --json and a uniform error path. */
export function def(parent: Command, spec: string, desc: string, fn: (...a: any[]) => void | Promise<void>): Command {
  const c = parent.command(spec).description(desc).option("--json", "makine okunur çıktı");
  c.action(async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (e) {
      fail(e);
    }
  });
  return c;
}

const WORKER_TASK_ID = /^T\d{8}-\d{2,}$/;
/** What a worker (VLAD_TASK_ID set) may write: its own task's log/ask/report/progress/pr, nothing else. */
const WORKER_CMDS = new Set(["task log", "task ask", "task report", "task progress", "task pr"]);

/**
 * Worker scope (security review): with VLAD_TASK_ID set a write command must be one of WORKER_CMDS and name that
 * same task; admin commands (quota, task set, grant, card answer, ...) and other tasks are refused. Defense in
 * depth next to the settings allowlist: a worker environment is ours, but nothing else stops `vlad quota set`.
 */
export function assertWorkerScope(cmd: string, firstArg: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const tid = env.VLAD_TASK_ID?.trim();
  if (!tid) return;
  if (!WORKER_TASK_ID.test(tid)) throw new Error(`VLAD_TASK_ID geçersiz: ${JSON.stringify(tid)}`);
  if (!WORKER_CMDS.has(cmd)) throw new Error(`worker bağlamında (VLAD_TASK_ID=${tid}) \`vlad ${cmd}\` yasak; yalnızca kendi görevine ${[...WORKER_CMDS].join("|")}`);
  if (firstArg !== tid) throw new Error(`worker bağlamında yalnızca kendi görevine (${tid}) yazılır: ${JSON.stringify(firstArg)}`);
}

/**
 * Like def, for commands that write under kb/: the action runs inside withKbLock, after the active-VLAD
 * write guard (design §13). `guard`: "full" (default), "worker" (a running worker's own log|ask|report may
 * pass), "off" (local-only files and the `active` commands themselves).
 */
export function defWrite(
  parent: Command,
  spec: string,
  desc: string,
  fn: (...a: any[]) => void | Promise<void>,
  opts: { guard?: GuardMode | ((o: Opts) => GuardMode) } = {},
): Command {
  return def(parent, spec, desc, (...args: any[]) =>
    withKbLock(() => {
      assertWorkerScope(`${parent.name()} ${spec.split(/\s/)[0]}`, args[0]);
      const mode = typeof opts.guard === "function" ? opts.guard(args[args.length - 2] ?? {}) : (opts.guard ?? "full");
      // a worker command's first argument is the task id it writes to
      for (const w of activeGuard(mode, { taskId: typeof args[0] === "string" ? args[0] : undefined })) process.stderr.write(`uyarı: ${w}\n`);
      return fn(...args);
    }),
  );
}
