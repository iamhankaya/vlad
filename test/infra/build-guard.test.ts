import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBuild } from "../support/build.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) {
    // only ever delete what this file created under the OS temp dir
    if (realpathSync(d).startsWith(realpathSync(tmpdir()))) rmSync(d, { recursive: true, force: true });
  }
});

/** Fake repo: src/a.ts, package.json and dist/cli.js with explicit mtimes (seconds since epoch). */
function fakeRepo(o: { dist?: number | null; src: number; pkg: number }): string {
  const root = mkdtempSync(join(tmpdir(), "vlad-build-guard-"));
  made.push(root);
  mkdirSync(join(root, "src", "sub"), { recursive: true });
  writeFileSync(join(root, "src", "sub", "a.ts"), "x");
  writeFileSync(join(root, "package.json"), "{}");
  utimesSync(join(root, "src", "sub", "a.ts"), o.src, o.src);
  utimesSync(join(root, "package.json"), o.pkg, o.pkg);
  if (o.dist !== null && o.dist !== undefined) {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "cli.js"), "x");
    utimesSync(join(root, "dist", "cli.js"), o.dist, o.dist);
  }
  return root;
}

describe("ensureBuild", () => {
  it("builds exactly once when VLAD_SKIP_BUILD is unset", () => {
    let n = 0;
    ensureBuild(fakeRepo({ dist: null, src: 100, pkg: 100 }), {}, () => void n++);
    expect(n).toBe(1);
  });

  it("skips the build with VLAD_SKIP_BUILD=1 when dist is fresh", () => {
    let n = 0;
    ensureBuild(fakeRepo({ dist: 200, src: 100, pkg: 100 }), { VLAD_SKIP_BUILD: "1" }, () => void n++);
    expect(n).toBe(0);
  });

  it("fails on stale dist (older than src/**) instead of building", () => {
    let n = 0;
    expect(() => ensureBuild(fakeRepo({ dist: 100, src: 200, pkg: 50 }), { VLAD_SKIP_BUILD: "1" }, () => void n++)).toThrow(/dist bayat: önce npm run build/);
    expect(n).toBe(0);
  });

  it("fails on stale dist (older than package.json)", () => {
    expect(() => ensureBuild(fakeRepo({ dist: 100, src: 50, pkg: 200 }), { VLAD_SKIP_BUILD: "1" }, () => {})).toThrow(/dist bayat/);
  });

  it("fails when dist/cli.js is missing", () => {
    expect(() => ensureBuild(fakeRepo({ dist: null, src: 50, pkg: 50 }), { VLAD_SKIP_BUILD: "1" }, () => {})).toThrow(/dist bayat/);
  });

  it("treats anything other than 1 as not skipping", () => {
    let n = 0;
    ensureBuild(fakeRepo({ dist: null, src: 50, pkg: 50 }), { VLAD_SKIP_BUILD: "0" }, () => void n++);
    expect(n).toBe(1);
  });
});
