import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commitKb, git as kbGit } from "../../src/kb/commit.js";
import { makeHome } from "../helpers.js";

const ident = {
  GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t",
};
let home: string;
const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: home, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...ident } }).trim();

beforeEach(() => {
  home = makeHome();
  Object.assign(process.env, ident);
  git("init", "-b", "main");
  writeFileSync(join(home, ".gitignore"), "kb/inbox/\nkb/logs/\nschemas/\n");
  writeFileSync(join(home, "code.ts"), "1");
  git("add", ".gitignore", "code.ts");
  git("commit", "-m", "init");
});

describe("commitKb", () => {
  it("commits only kb/ changes with a kb: prefix, leaving code changes and ignored files alone", () => {
    writeFileSync(join(home, "kb", "tasks", "T1.md"), "x");
    writeFileSync(join(home, "kb", "logs", "hook.log"), "secret");
    writeFileSync(join(home, "code.ts"), "2");
    git("add", "code.ts"); // even a staged code change must stay out
    const r = commitKb("digest 2026-10-15");
    expect(r.committed).toBe(true);
    expect(git("log", "-1", "--format=%s")).toBe("kb: digest 2026-10-15");
    expect(git("show", "--name-only", "--format=", "HEAD").split("\n")).toEqual(["kb/tasks/T1.md"]);
    expect(git("status", "--porcelain")).toBe("M  code.ts");
  });

  it("is a no-op when kb/ has no changes", () => {
    const head = git("rev-parse", "HEAD");
    expect(commitKb("boş")).toEqual({ committed: false });
    expect(git("rev-parse", "HEAD")).toBe(head);
  });

  it("with push: pushes the kb commit to the upstream", () => {
    const remote = mkdtempSync(join(tmpdir(), "vlad-remote-"));
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remote, stdio: "pipe" });
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
    writeFileSync(join(home, "kb", "tasks", "T1.md"), "x");
    const r = commitKb("push testi", { push: true });
    expect(r).toMatchObject({ committed: true, pushed: true });
    expect(execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: remote, encoding: "utf8" }).trim()).toBe("kb: push testi");
  });

  it("with push and nothing to commit: still pushes earlier unpushed kb commits", () => {
    const remote = mkdtempSync(join(tmpdir(), "vlad-remote-"));
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remote, stdio: "pipe" });
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
    writeFileSync(join(home, "kb", "tasks", "T1.md"), "x");
    commitKb("önce");
    expect(commitKb("sonra", { push: true })).toEqual({ committed: false, pushed: true });
    expect(execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: remote, encoding: "utf8" }).trim()).toBe("kb: önce");
  });

  it("with push: does not push when unpushed commits touch files outside kb/", () => {
    const remote = mkdtempSync(join(tmpdir(), "vlad-remote-"));
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remote, stdio: "pipe" });
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
    writeFileSync(join(home, "code.ts"), "2");
    git("commit", "-q", "-am", "kod");
    writeFileSync(join(home, "kb", "tasks", "T1.md"), "x");
    const r = commitKb("kb", { push: true });
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(false);
    expect(r.warning).toMatch(/kb dışı/);
    expect(execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: remote, encoding: "utf8" }).trim()).toBe("init");
  });

  it("with push: ignores code commits already on another remote branch even with an upstream", () => {
    const remote = mkdtempSync(join(tmpdir(), "vlad-remote-"));
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remote, stdio: "pipe" });
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
    git("checkout", "-q", "-b", "session");
    git("push", "-u", "origin", "session");
    git("checkout", "-q", "main");
    writeFileSync(join(home, "code.ts"), "2");
    git("commit", "-q", "-am", "kod");
    git("push", "-q", "origin", "main");
    git("checkout", "-q", "session");
    git("merge", "-q", "--ff-only", "main");
    writeFileSync(join(home, "kb", "tasks", "T1.md"), "x");
    const r = commitKb("kb", { push: true });
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(true);
    expect(r.warning).toBeUndefined();
    expect(execFileSync("git", ["log", "-1", "--format=%s", "session"], { cwd: remote, encoding: "utf8" }).trim()).toBe("kb: kb");
  });

  it("rejects an empty message", () => {
    expect(() => commitKb("  ")).toThrow(/mesaj/);
  });
});

describe("F-vlad-073/ git helper network safety", () => {
  it("runs git with GIT_TERMINAL_PROMPT=0", () => {
    expect(kbGit(process.cwd(), ["-c", "alias.e=!echo $GIT_TERMINAL_PROMPT", "e"]).trim()).toBe("0");
  });
  it("kills a call that outlives timeoutMs", () => {
    expect(() => kbGit(process.cwd(), ["-c", "alias.s=!sleep 5", "s"], 200)).toThrow(/git .* başarısız/);
  });
});
