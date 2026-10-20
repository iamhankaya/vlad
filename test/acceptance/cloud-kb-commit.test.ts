// Spec "VLAD doğrulama notu": upstream'siz session branch'inde `kb commit --push` hata vermemeli,
// `git push -u origin <branch>` ile ilk push'u yapmalı. Senaryo 12'nin (origin/master merge) kodlanabilir kısmı
// skill/akış düzeyindedir; burada yalnızca upstream'siz push test edilir.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commitKb } from "../../src/kb/commit.js";
import { makeHome } from "../helpers.js";

const ident = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
let home: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: home, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...ident } }).trim();

beforeEach(() => {
  home = makeHome();
  Object.assign(process.env, ident);
  git("init", "-b", "main");
  writeFileSync(join(home, ".gitignore"), "kb/inbox/\nkb/logs/\nschemas/\n");
  writeFileSync(join(home, "code.ts"), "1");
  git("add", ".gitignore", "code.ts");
  git("commit", "-m", "init");
});

describe("commitKb --push, upstream'siz session branch'i", () => {
  it("upstream yoksa origin'e -u ile push eder", () => {
    const remote = mkdtempSync(join(tmpdir(), "vlad-remote-"));
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remote, stdio: "pipe" });
    git("remote", "add", "origin", remote);
    git("push", "origin", "main");
    git("checkout", "-b", "ccr-session-branch");
    writeFileSync(join(home, "kb", "tasks", "T1.md"), "x");
    const r = commitKb("bulut", { push: true });
    expect(r).toMatchObject({ committed: true, pushed: true });
    expect(execFileSync("git", ["log", "-1", "--format=%s", "ccr-session-branch"], { cwd: remote, encoding: "utf8" }).trim()).toBe("kb: bulut");
    expect(git("rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/ccr-session-branch");
  });

  it("upstream'siz branch'te kb dışı commit varsa yine push etmez, uyarır", () => {
    const remote = mkdtempSync(join(tmpdir(), "vlad-remote-"));
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remote, stdio: "pipe" });
    git("remote", "add", "origin", remote);
    git("push", "origin", "main");
    git("checkout", "-b", "ccr-session-branch");
    writeFileSync(join(home, "code.ts"), "2");
    git("commit", "-am", "kod");
    writeFileSync(join(home, "kb", "tasks", "T1.md"), "x");
    const r = commitKb("bulut", { push: true });
    expect(r.pushed).toBe(false);
    expect(r.warning).toMatch(/code\.ts/);
    expect(execFileSync("git", ["branch", "--list"], { cwd: remote, encoding: "utf8" })).not.toContain("ccr-session-branch");
  });
});
