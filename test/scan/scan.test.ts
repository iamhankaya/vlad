import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, kbPaths } from "../../src/kb/index.js";
import { scanRoots, slugify } from "../../src/scan/scan.js";
import { makeHome } from "../helpers.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

describe("scan", () => {
  let root: string;
  beforeEach(() => {
    makeHome();
    root = mkdtempSync(join(tmpdir(), "vlad-scan-"));
    const alpha = join(root, "alpha");
    mkdirSync(alpha);
    git(alpha, "init", "-q");
    writeFileSync(join(alpha, "README.md"), "# Alpha\n");
    writeFileSync(
      join(alpha, "package.json"),
      JSON.stringify({ name: "alpha-pkg", description: "d", dependencies: { x: "1" }, scripts: { build: "b" } }),
    );
    git(alpha, "add", "-A");
    git(alpha, "commit", "-q", "-m", "init");
    const beta = join(root, "beta-wt");
    mkdirSync(beta);
    git(beta, "init", "-q");
    mkdirSync(join(root, "notes"));
  });

  it("slugify", () => {
    expect(slugify("My Proj_X")).toBe("my-proj-x");
  });

  it("scans only non-ignored git folders", () => {
    const repos = scanRoots({ ...defaultConfig(), roots: [root] });
    expect(repos.map((r) => r.slug)).toEqual(["alpha"]);
    const a = repos[0];
    expect(a.commits.length).toBe(1);
    expect(a.commits[0].subject).toBe("init");
    expect(a.readme).toContain("# Alpha");
    expect(a.manifest).toMatchObject({ name: "alpha-pkg", dependencies: ["x"], scripts: ["build"] });
    expect(a.hasCard).toBe(false);
  });

  it("hasCard true once a card exists", () => {
    writeFileSync(join(kbPaths().projects, "alpha.md"), "---\nslug: alpha\n---\n");
    const repos = scanRoots({ ...defaultConfig(), roots: [root] });
    expect(repos[0].hasCard).toBe(true);
  });
});
