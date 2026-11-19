import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runSpawn } from "./spawn-vlad.js";

// F-vlad-121 measurement: the reporter appends one JSONL row per red test; runs here happen in a temp project (never the repo's .vitest-red.jsonl)
const repo = join(import.meta.dirname, "..", "..");
const reporterPath = join(import.meta.dirname, "flaky-reporter.ts");
const vitestCli = join(repo, "node_modules", "vitest", "vitest.mjs");
const vitestEntry = join(repo, "node_modules", "vitest", "dist", "index.js");
const made: string[] = [];

function project(testBody: string, file?: string): { dir: string; out: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vlad-flaky-rep-")));
  made.push(dir);
  const out = join(dir, "red.jsonl");
  const cfg = { test: { reporters: [[reporterPath, { file: file ?? out }]], testTimeout: 300 } };
  writeFileSync(join(dir, "vitest.config.mjs"), `export default ${JSON.stringify(cfg)};\n`);
  mkdirSync(join(dir, "t"));
  writeFileSync(join(dir, "t", "x.test.mjs"), `import { it, expect } from ${JSON.stringify(vitestEntry)};\n${testBody}\n`);
  return { dir, out };
}
const run = (dir: string) => runSpawn(process.execPath, [vitestCli, "run", "--root", dir, "--config", join(dir, "vitest.config.mjs")], { cwd: dir, timeoutMs: 60_000 });
const rowsOf = (out: string) => readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));

afterAll(() => {
  const base = realpathSync(tmpdir());
  for (const d of made) if (d.startsWith(base)) rmSync(d, { recursive: true, force: true });
});

describe("flaky-reporter", () => {
  it("appends one row with the agreed fields for a deliberately red test", () => {
    const { dir, out } = project(`it("kasten kirmizi", () => { expect(1).toBe(2); });`);
    expect(run(dir).status).toBe(1);
    const rows = rowsOf(out);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["at", "durationMs", "error", "file", "maxWorkers", "name", "sha", "timedOut"]);
    expect(rows[0]).toMatchObject({ file: "t/x.test.mjs", name: "kasten kirmizi", timedOut: false });
    expect(rows[0].error.split("\n")).toHaveLength(1);
    expect(typeof rows[0].durationMs).toBe("number");
    expect(typeof rows[0].maxWorkers).toBe("number");
    expect(Number.isNaN(Date.parse(rows[0].at))).toBe(false);
  });

  it("marks a test timeout as timedOut", () => {
    const { dir, out } = project(`it("yavas", async () => { await new Promise((r) => setTimeout(r, 2000)); });`);
    run(dir);
    const rows = rowsOf(out);
    expect(rows).toHaveLength(1);
    expect(rows[0].timedOut).toBe(true);
  });

  it("writes nothing for a fully green run", () => {
    const { dir, out } = project(`it("yesil", () => { expect(1).toBe(1); });`);
    expect(run(dir).status).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it("a reporter write failure (target is a directory) neither changes the exit code nor surfaces as an error", () => {
    const sink = realpathSync(mkdtempSync(join(tmpdir(), "vlad-flaky-sink-")));
    made.push(sink);
    const green = project(`it("yesil", () => { expect(1).toBe(1); });`, sink);
    expect(run(green.dir).status).toBe(0);
    const red = project(`it("kirmizi", () => { expect(1).toBe(2); });`, sink);
    const r = run(red.dir);
    expect(r.status).toBe(1); // same code as without the reporter: the test failure itself
    expect(r.stderr + r.stdout).not.toMatch(/EISDIR|Unhandled|flaky-reporter/);
  });
});
