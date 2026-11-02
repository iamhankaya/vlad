import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchOp, resumeOp } from "../../src/agent/ops/launch.js";
import { defaultConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { ensureIntegrationGitWith, type GitApi } from "../../src/tasks/launch-core.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const ID = "T20261102-71";

let base: string; let home: string; let saved: Record<string, string | undefined>; let reqs: LaunchRequest[];
const launcher: Launcher = { launch: async (r) => { reqs.push(r); return { ok: true, method: "fake" }; } };
beforeEach(() => {
  saved = Object.fromEntries(["VLAD_HOME", "VLAD_KB_DIR", "VLAD_MACHINE", "VLAD_CLAUDE_JSON"].map((k) => [k, process.env[k]]));
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-f1bl-")));
  const roots = join(base, "roots"); const repo = join(roots, "alpha");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "f.txt"), "1"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "i");
  home = makeHome();
  const kbDir = join(base, "worker-kb");
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, roots: [roots], kbDir }] }));
  process.env.VLAD_MACHINE = "windows";
  process.env.VLAD_CLAUDE_JSON = join(base, "claude.json");
  reqs = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmTemp(base); rmTemp(home);
});

const L = { taskId: ID, project: "alpha", repoName: "alpha", branch: `vlad/${ID}`, base: { kind: "default" }, promptTemplate: "x", title: "T" };

describe("F-vlad-147: işçinin kbDir'i başlatılan oturuma ortam değişkeni olarak geçer", () => {
  it("launch: VLAD_KB_DIR = machines[].kbDir", async () => {
    await launchOp(L, { from: "mac", opId: "op-1" }, { launcher });
    expect(reqs[0]!.env).toMatchObject({ VLAD_KB_DIR: join(base, "worker-kb") });
  });
  it("resume: aynı değişken", async () => {
    await launchOp(L, { from: "mac", opId: "op-1" }, { launcher });
    await resumeOp({ taskId: ID, project: "alpha", repoName: "alpha", promptTemplate: "x", title: "T" }, { launcher, close: () => [] });
    expect(reqs[1]!.env).toMatchObject({ VLAD_KB_DIR: join(base, "worker-kb") });
  });
});

describe("F-vlad-148: entegrasyon worktree yolu işçinin işletim sistemi ayırıcısıyla kurulur", () => {
  const fakeGit = (): GitApi => ({
    addWorktree: async () => {}, attachWorktree: async () => {}, worktreeBranch: async () => null, removeWorktree: async () => {},
    branchExists: async () => false, remoteBranchExists: async () => false, isWorktree: async () => true, runGit: async () => null,
  });
  it("linux/darwin → '/', win32 → '\'", async () => {
    const cfg = { ...defaultConfig(), worktreeDir: "/srv/wt" };
    expect((await ensureIntegrationGitWith(fakeGit(), "/srv/repo", "T20261101-60", cfg, undefined, "linux")).worktree).toBe("/srv/wt/T20261101-60");
    expect((await ensureIntegrationGitWith(fakeGit(), "C:\\r", "T20261101-60", { ...cfg, worktreeDir: "C:\\wt" }, undefined, "win32")).worktree).toBe("C:\\wt\\T20261101-60");
  });
});

import { cleanupOp } from "../../src/agent/ops/launch.js";
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";

describe("F-vlad-133: cleanup, worktree'nin kendi görev klasörü olduğunu doğrular", () => {
  it("worktree yolu kardeş görevin klasörüne junction ise forbidden; kardeşin içeriği silinmez", async () => {
    const r = await launchOp(L, { from: "mac", opId: "op-1" }, { launcher });
    const sibling = join(r.worktree, "..", "T20261102-72");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "keep.txt"), "x");
    rmSync(r.worktree, { recursive: true, force: true });
    symlinkSync(sibling, r.worktree, "junction");
    await expect(cleanupOp({ taskId: ID, project: "alpha", repoName: "alpha", terminal: true }, { close: () => [] })).rejects.toMatchObject({ code: "forbidden" });
    expect(readFileSync(join(sibling, "keep.txt"), "utf8")).toBe("x");
    expect(existsSync(sibling)).toBe(true);
  });
});
