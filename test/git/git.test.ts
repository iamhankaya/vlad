import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addWorktree, attachWorktree, branchExists, changedFiles, currentBranch, headSha, isRepo,
  recentCommits, removeWorktree, runGit, worktreePath,
} from "../../src/git/git.js";
import type { VladConfig } from "../../src/kb/index.js";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vlad-git-"));
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "1");
  git(dir, "add", "."); git(dir, "commit", "-m", "first");
  writeFileSync(join(dir, "b.txt"), "2");
  git(dir, "add", "."); git(dir, "commit", "-m", "second");
  return dir;
}

describe("worktree from a base", () => {
  it("addWorktree with base branches from that commit; attachWorktree reuses a branch", () => {
    const repo = makeRepo();
    git(repo, "branch", "side", "HEAD~1");
    const wt = join(mkdtempSync(join(tmpdir(), "vlad-wt-")), "w");
    addWorktree(repo, wt, "child", "side");
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
    expect(existsSync(join(wt, "b.txt"))).toBe(false);
    const wt2 = join(mkdtempSync(join(tmpdir(), "vlad-wt-")), "w");
    attachWorktree(repo, wt2, "side");
    expect(currentBranch(wt2)).toBe("side");
    expect(branchExists(repo, "side")).toBe(true);
    expect(branchExists(repo, "yok")).toBe(false);
  });
});

describe("git helpers", () => {
  it("runGit returns null outside a repo", () => {
    // tmpdir may live inside a user-level repo; stop git's upward search there
    process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    const d = mkdtempSync(join(tmpdir(), "vlad-nogit-"));
    expect(runGit(d, ["rev-parse", "HEAD"])).toBeNull();
    expect(isRepo(d)).toBe(false);
  });

  it("basic queries", () => {
    const r = makeRepo();
    expect(isRepo(r)).toBe(true);
    expect(currentBranch(r)).toBe("main");
    expect(headSha(r)).toMatch(/^[0-9a-f]{40}$/);
    const c = recentCommits(r, null);
    expect(c.map((x) => x.subject)).toEqual(["second", "first"]);
    expect(recentCommits(r, null, 1)).toHaveLength(1);
  });

  it("changedFiles unions worktree changes and last commit", () => {
    const r = makeRepo();
    writeFileSync(join(r, "c.txt"), "3");
    writeFileSync(join(r, "b.txt"), "changed");
    expect(changedFiles(r).sort()).toEqual(["b.txt", "c.txt"]);
  });

  it("changedFiles keeps non-ASCII filenames", () => {
    const r = makeRepo();
    writeFileSync(join(r, "ğüş.txt"), "x");
    expect(changedFiles(r)).toContain("ğüş.txt");
    git(r, "add", "."); git(r, "commit", "-m", "tr");
    expect(changedFiles(r)).toEqual(["ğüş.txt"]);
  });

  it("addWorktree creates dir and branch, refuses overwrite, remove works", () => {
    const r = makeRepo();
    const dir = join(mkdtempSync(join(tmpdir(), "vlad-wt-")), "T20261015-01");
    addWorktree(r, dir, "vlad/T20261015-01");
    expect(existsSync(dir)).toBe(true);
    expect(currentBranch(dir)).toBe("vlad/T20261015-01");
    expect(() => addWorktree(r, dir, "vlad/T20261015-01")).toThrow(/zaten var/);
    expect(() => addWorktree(r, dir + "x", "vlad/T20261015-01")).toThrow(/zaten var/);
    removeWorktree(r, dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("worktreePath substitutes {repo}", () => {
    const cfg = { worktreeDir: "{repo}-wt" } as VladConfig;
    expect(worktreePath(cfg, "C:\\dev\\watchparty", "T20261015-01")).toBe("C:\\dev\\watchparty-wt\\T20261015-01");
  });
});
