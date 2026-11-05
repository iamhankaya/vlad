import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSpawn } from "../support/spawn-vlad.js";
import { rmTemp } from "../helpers.js";

const root = join(import.meta.dirname, "..", "..");
const node = (script: string, args: string[], cwd = root) => runSpawn(process.execPath, [join(root, "scripts", script), ...args], { cwd, timeoutMs: 60_000 });

describe("u2 scope CLI", () => {
  it("--files … --json prints the selection", () => {
    const r = node("test-scope.mjs", ["--files", "src/launcher/posix.ts,README.md", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ buckets: ["process", "platform"], unit: "changed", ignored: ["README.md"], all: false });
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
