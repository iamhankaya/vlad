import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const STREAM_FIXTURES = resolve(import.meta.dirname, "..", "..", "..", "contract", "fixtures", "external", "claude-stream-json");

/** What one fake `claude` invocation does. Steps are consumed in call order; the last one repeats. */
export interface FakeStep {
  /** A real recording under contract/fixtures/external/claude-stream-json (the `_fixture_header` line is skipped). */
  fixture?: string;
  /** Raw stdout lines instead of / after the fixture. */
  lines?: string[];
  /** Extra junk line of this many bytes before the rest. */
  bigLine?: number;
  exit?: number;
  stderr?: string;
  /** After printing, never exit (records its pid in `started`). */
  hang?: boolean;
  /** Leave a background child (same process group) running when the turn ends normally; its pid goes to `bg.pid`. */
  bg?: boolean;
}

const SCRIPT = `
const fs = require("fs"), path = require("path");
const dir = __dirname;
const steps = JSON.parse(fs.readFileSync(path.join(dir, "scenario.json"), "utf8"));
const callsFile = path.join(dir, "calls.jsonl");
const n = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\\n").filter(Boolean).length : 0;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  fs.appendFileSync(callsFile, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env), stdin, cwd: process.cwd() }) + "\\n");
  const step = steps[Math.min(n, steps.length - 1)] || {};
  const out = [];
  if (step.bigLine) out.push("x".repeat(step.bigLine));
  if (step.fixture) {
    for (const l of fs.readFileSync(path.join(process.env.FAKE_FIXTURES || ${JSON.stringify(STREAM_FIXTURES)}, step.fixture), "utf8").split("\\n")) {
      if (l && !l.includes('"_fixture_header"')) out.push(l);
    }
  }
  for (const l of step.lines || []) out.push(l);
  if (out.length) process.stdout.write(out.join("\\n") + "\\n");
  if (step.stderr) process.stderr.write(step.stderr);
  if (step.bg) {
    const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    c.unref(); // the turn process may end while it lives on
    fs.writeFileSync(path.join(dir, "bg.pid"), String(c.pid));
  }
  if (step.hang) {
    fs.writeFileSync(path.join(dir, "started"), String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    process.exitCode = step.exit || 0;
  }
});
`;

export interface FakeClaude {
  bin: string;
  dir: string;
  setSteps(steps: FakeStep[]): void;
  calls(): { argv: string[]; env: string[]; stdin: string; cwd: string }[];
  startedPid(): number | null;
  bgPid(): number | null;
}

/** An executable `claude` stand-in in `dir`: replays fixtures, records argv/env/stdin of every call. */
export function makeFakeClaude(dir: string): FakeClaude {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!${process.execPath}\n${SCRIPT}`);
  chmodSync(bin, 0o755);
  const calls = join(dir, "calls.jsonl");
  const api: FakeClaude = {
    bin, dir,
    setSteps(steps) {
      writeFileSync(join(dir, "scenario.json"), JSON.stringify(steps));
      rmSync(calls, { force: true });
      rmSync(join(dir, "started"), { force: true });
      rmSync(join(dir, "bg.pid"), { force: true });
    },
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    bgPid: () => (existsSync(join(dir, "bg.pid")) ? Number(readFileSync(join(dir, "bg.pid"), "utf8")) : null),
    startedPid: () => (existsSync(join(dir, "started")) ? Number(readFileSync(join(dir, "started"), "utf8")) : null),
  };
  api.setSteps([{}]);
  return api;
}
