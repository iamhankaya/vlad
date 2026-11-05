import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, kbPaths } from "../../src/kb/index.js";
import type { VladConfig } from "../../src/kb/index.js";
import { kbDirtyOnWorker } from "../../src/kb/worker-dirty.js";
import { statusSummary } from "../../src/tasks/launch.js";
import { makeHome } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe" });
const cfg = (): VladConfig => ({
  ...defaultConfig(), brain: "mac",
  machines: [{ name: "mac", os: "darwin", agent: { host: "h", port: 7437 } }, { name: "windows", os: "win32", agent: { host: "w", port: 7437 } }],
});
let kb: string;
const prevMachine = process.env.VLAD_MACHINE;
beforeEach(() => {
  makeHome();
  kb = kbPaths().kb;
  git(kb, "init", "-b", "main");
  writeFileSync(join(kb, "a.md"), "1");
  git(kb, "add", "."); git(kb, "commit", "-m", "first");
});
afterEach(() => { if (prevMachine === undefined) delete process.env.VLAD_MACHINE; else process.env.VLAD_MACHINE = prevMachine; });

describe("F-vlad-196: kb dirty on a non-brain machine", () => {
  it("warns on a worker whose kb has uncommitted changes, with the files and the recovery path", () => {
    process.env.VLAD_MACHINE = "windows";
    writeFileSync(join(kb, "a.md"), "changed");
    writeFileSync(join(kb, "new.md"), "x");
    const w = kbDirtyOnWorker(cfg())!;
    expect(w.machine).toBe("windows");
    expect(w.files.sort()).toEqual(["a.md", "new.md"]);
    expect(w.message).toMatch(/commit'lenmemiş.*a\.md.*ayrı dala commit.*beyinde.*CLI/s);
  });
  it("is silent on a clean kb, on the brain, and without machines", () => {
    process.env.VLAD_MACHINE = "windows";
    expect(kbDirtyOnWorker(cfg())).toBeNull();
    writeFileSync(join(kb, "a.md"), "changed");
    process.env.VLAD_MACHINE = "mac";
    expect(kbDirtyOnWorker(cfg())).toBeNull();
    process.env.VLAD_MACHINE = "windows";
    expect(kbDirtyOnWorker(defaultConfig())).toBeNull();
  });
  it("statusSummary carries the warning (status/SessionStart line)", () => {
    process.env.VLAD_MACHINE = "windows";
    writeFileSync(join(kb, "a.md"), "changed");
    expect(statusSummary(cfg(), new Date(), undefined, undefined, { mark: false }).kbDirty?.files).toEqual(["a.md"]);
  });
});
