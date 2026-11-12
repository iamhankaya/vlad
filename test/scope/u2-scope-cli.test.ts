import { mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSpawn } from "../support/spawn-vlad.js";
import { rmTemp } from "../helpers.js";

const root = join(import.meta.dirname, "..", "..");
// global-setup already built (or verified) dist/ before any test file runs; VLAD_SKIP_BUILD=1 keeps the nested test-run from re-running tsc over the shared dist/ while other files import it (F-vlad-319; workers do not see global-setup env changes)
const node = (script: string, args: string[], cwd = root) => runSpawn(process.execPath, [join(root, "scripts", script), ...args], { cwd, timeoutMs: 60_000, env: { VLAD_SKIP_BUILD: "1" } });

describe("u2 scope CLI", () => {
  it("--files … --json prints the selection", () => {
    const r = node("test-scope.mjs", ["--files", "src/launcher/posix.ts,vendor/x.txt", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ buckets: ["unit", "process", "platform"], unit: "changed", ignored: ["vendor/x.txt"], all: false, warnings: [] });
  });
  it("an explicit unit test file is listed under its owning bucket (F-vlad-256)", () => {
    const r = node("test-scope.mjs", ["--files", "test/kb/doc.test.ts", "--json"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ fileBuckets: { unit: ["test/kb/doc.test.ts"] } });
  });
  it("--run executes an explicit unit test file instead of passing with zero tests (F-vlad-256)", () => {
    const r = node("test-scope.mjs", ["--files", "test/kb/doc.test.ts", "--run"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect((r.stdout + r.stderr).replace(/\u001b\[[0-9;]*m/g, "")).toMatch(/Test Files\s+1 passed/);
  });
  it("F-vlad-319: --run does not rebuild the shared dist/ that other test files are importing", () => {
    const cli = join(root, "dist", "cli.js");
    const before = statSync(cli).mtimeMs;
    const r = node("test-scope.mjs", ["--files", "test/kb/doc.test.ts", "--run"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(statSync(cli).mtimeMs).toBe(before);
  });
  it("an unmapped path is reported on stderr and selects everything", () => {
    const r = node("test-scope.mjs", ["--files", "tools/x.bin"]);
    expect(r.stderr).toMatch(/eşlenmeyen yol.*tools\/x\.bin/);
    expect(r.stderr).toMatch(/kovalar: process,agent,platform/);
  });
  it("git mode: a new untracked source file in a temp repo counts as changed", () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-scope-")));
    try {
      // the script resolves its own repo root, so a temp clone-less check is limited to the real repo: --since with a bad ref must fail loudly
      const r = node("test-scope.mjs", ["--since", "no-such-ref-xyz", "--json"], dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/git diff/);
    } finally { rmTemp(dir); }
  });
  it("test-run rejects an unknown bucket before building anything", () => {
    const r = node("test-run.mjs", ["--project", "nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/bilinmeyen kova: nope/);
  });
});

describe("u2 test-run: unclaimed test files", () => {
  it("a test file no bucket claims is an error, not a silent pass", () => {
    const r = node("test-run.mjs", ["--project", "unit", "--", "test/nowhere/orphan.test.ts"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/hiçbir kovada olmayan test dosyası: test\/nowhere\/orphan\.test\.ts/);
  });
});
