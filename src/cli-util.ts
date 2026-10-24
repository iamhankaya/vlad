import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { TRANSITIONS, TransitionError } from "./tasks/index.js";
import type { Task } from "./tasks/index.js";
import { ValidationError } from "./kb/index.js";

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
