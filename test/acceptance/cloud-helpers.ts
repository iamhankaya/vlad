import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";

export const root = resolve(import.meta.dirname, "..", "..");
export const cli = join(root, "dist", "cli.js");

export function build(): void {
  const r = spawnSync("npx", ["tsc"], { cwd: root, shell: true, encoding: "utf8" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

/** Runs the built CLI. `env` entries set to undefined are removed from the child environment. */
export function vlad(home: string, args: string[], o: { input?: string; env?: Record<string, string | undefined> } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, VLAD_HOME: home, ...o.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", input: o.input, env: env as NodeJS.ProcessEnv });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Environment of a cloud Claude Code container. */
export const CLOUD_ENV = { CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: "session_test" };
/** Environment with every cloud marker removed. */
export const NO_CLOUD_ENV = { CLAUDE_CODE_REMOTE: undefined, CLAUDE_CODE_REMOTE_SESSION_ID: undefined };

export function writeCard(home: string, slug: string, extra: Record<string, string> = {}): void {
  const f = join(home, "card.md");
  const extraLines = Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(f, `---
slug: ${slug}
name: ${slug}
path: "C:\\\\dev\\\\${slug}"
${extraLines}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`);
  const r = vlad(home, ["project", "write", slug, "--file", f, "--json"]);
  expect(r.code, r.err).toBe(0);
}

export function writeRoles(home: string): void {
  mkdirSync(join(home, "roles"), { recursive: true });
  writeFileSync(join(home, "roles", "tester.md"),
    "---\nslug: tester\ntitle: Senior Tester\nkind: executor\nsummary: s\nmodel: sonnet\n---\n\nTester gövdesi RolGovdesiMarker.\n");
}

export function newTask(home: string, args: string[] = [], body = "## Tanım\nBulut görev gövdesi\n"): string {
  const r = vlad(home, ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", ...args, "--json"], { input: body });
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out).id as string;
}

export function taskFile(home: string, id: string): string {
  return join(home, "kb", "tasks", readdirSync(join(home, "kb", "tasks")).find((n) => n.startsWith(id))!);
}
export const readTask = (home: string, id: string) => readFileSync(taskFile(home, id), "utf8");
export const taskState = (home: string, id: string): string =>
  JSON.parse(vlad(home, ["task", "list", "--json"]).out).tasks.find((t: { id: string }) => t.id === id).state;

export function tmp(prefix = "vlad-acc-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Forces the state in the task file (queued -> running) as the existing CLI tests do. */
export function forceRunning(home: string, id: string): void {
  const f = taskFile(home, id);
  writeFileSync(f, readFileSync(f, "utf8").replace("state: queued", "state: running"));
}

export const assistantEvent = (text: string) =>
  ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
export const userEvent = (text: string) =>
  ({ type: "user", message: { role: "user", content: text } });
export const jsonl = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
