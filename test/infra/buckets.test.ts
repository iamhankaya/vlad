import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importClosure, listTestFiles, matchGlob, usesSpawnOrDist } from "../support/test-scan.js";

const root = join(import.meta.dirname, "..", "..");
const buckets = JSON.parse(readFileSync(join(root, "test", "buckets.json"), "utf8")) as Record<string, string[]>;
const files = listTestFiles(root);

describe("matchGlob", () => {
  it("supports * within a segment and ** across segments", () => {
    expect(matchGlob("test/a/b.test.ts", "test/**/*.test.ts")).toBe(true);
    expect(matchGlob("test/b.test.ts", "test/**/*.test.ts")).toBe(true);
    expect(matchGlob("test/a/b.test.ts", "test/*.test.ts")).toBe(false);
    expect(matchGlob("test/a/b.test.ts", "test/a/b.test.ts")).toBe(true);
    expect(matchGlob("test/a/bXtest.ts", "test/a/b.test.ts")).toBe(false);
  });
});

describe("test/buckets.json partition", () => {
  it("defines exactly the four buckets", () => {
    expect(Object.keys(buckets).sort()).toEqual(["agent", "platform", "process", "unit"]);
  });

  it("puts every test file into exactly one bucket", () => {
    const unmatched: string[] = [];
    const multi: string[] = [];
    for (const f of files) {
      const hit = Object.entries(buckets).filter(([, globs]) => globs.some((g) => matchGlob(f, g))).map(([k]) => k);
      if (hit.length === 0) unmatched.push(f);
      if (hit.length > 1) multi.push(`${f} -> ${hit.join(",")}`);
    }
    expect({ unmatched, multi }).toEqual({ unmatched: [], multi: [] });
  });

  it("has no stale pattern (every glob matches a file)", () => {
    const stale = Object.entries(buckets).flatMap(([k, globs]) => globs.filter((g) => !files.some((f) => matchGlob(f, g))).map((g) => `${k}: ${g}`));
    expect(stale).toEqual([]);
  });

  it("keeps dist and child-process use out of the unit bucket, including helpers it imports", () => {
    const offenders = files
      .filter((f) => buckets.unit.some((g) => matchGlob(f, g)))
      .filter((f) => [...importClosure(root, f)].some((p) => usesSpawnOrDist(readFileSync(join(root, p), "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("follows static, side-effect, dynamic, single-quoted and mock imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "vlad-closure-"));
    try {
      mkdirSync(join(dir, "test"));
      const w = (n: string, c: string) => writeFileSync(join(dir, "test", n), c);
      w("t.test.ts", `import "./a.js";\nimport('./b.js');\nimport { x } from './c.js';\nvi.mock("./d.js");\nconst e = require("./e.js");`);
      for (const n of ["a", "b", "c", "d", "e"]) w(`${n}.ts`, "export {};");
      expect([...importClosure(dir, "test/t.test.ts")].sort()).toEqual(["test/a.ts", "test/b.ts", "test/c.ts", "test/d.ts", "test/e.ts", "test/t.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a spawn/dist use (scanner sanity)", () => {
    // the markers are assembled so this very (unit) file does not trip the scanner
    const cp = ["node:child", "process"].join("_");
    const dist = ["di", "st"].join("");
    expect(usesSpawnOrDist(`import { spawn } from "${cp}";`)).toBe(true);
    expect(usesSpawnOrDist(`const CLI = join(root, "${dist}", "cli.js");`)).toBe(true);
    expect(usesSpawnOrDist(`const x = 1;`)).toBe(false);
  });
});
