import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const TEST_DIR = join(import.meta.dirname, "..");
// support/ owns the guard itself; acceptance/ belongs to the tester role (migrated in its own task)
const SKIP = ["support", "acceptance", "fixtures"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return SKIP.includes(relative(TEST_DIR, p)) ? [] : files(p);
    return /\.(ts|mjs)$/.test(n) ? [p] : [];
  });
}

describe("F-vlad-258: unguarded spawnSync", () => {
  it("no test file outside support/ and acceptance/ imports spawnSync from node:child_process (use spawnGuarded: timeout + maxBuffer)", () => {
    const bad = files(TEST_DIR).filter((f) => /import\s*\{[^}]*\bspawnSync\b[^}]*\}\s*from\s*["']node:child_process["']/.test(readFileSync(f, "utf8")) && !f.endsWith("spawn-guard.test.ts"));
    expect(bad.map((f) => relative(TEST_DIR, f))).toEqual([]);
  });
});

describe("F-vlad-265: symlink fixture without privilege", () => {
  it("c2-worker-ops: the test that builds a symlink is skipped when canSymlink() is false (EPERM on unprivileged Windows)", () => {
    const src = readFileSync(join(TEST_DIR, "machines", "c2-worker-ops.test.ts"), "utf8");
    const itLines = src.split("\n").filter((l, i, a) => /^\s*it[.(]/.test(l) && a.slice(i, i + 6).some((x) => x.includes("symlinkSync(")));
    expect(itLines.length).toBeGreaterThan(0);
    for (const l of itLines) expect(l).toContain("it.skipIf(!canSymlink())(");
  });
  // F-vlad-290: script-integrity (2) and script-ops (1) built symlinks via symlinkIn() unguarded and went red with EPERM on Windows
  it.each(["script-integrity", "script-ops"])("%s: every test that builds a symlink via symlinkIn() is skipped when canSymlink() is false", (name) => {
    const src = readFileSync(join(TEST_DIR, "machines", `${name}.test.ts`), "utf8");
    const itLines = src.split("\n").filter((l, i, a) => /^\s*it[.(]/.test(l) && a.slice(i, i + 6).some((x) => /\bsymlinkIn\(|symlinkSync\(/.test(x)));
    expect(itLines.length).toBeGreaterThan(0);
    for (const l of itLines) expect(l).toContain("it.skipIf(!canSymlink())(");
  });
});
