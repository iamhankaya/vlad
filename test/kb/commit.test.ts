import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commitKb } from "../../src/kb/commit.js";
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

  it("rejects an empty message", () => {
    expect(() => commitKb("  ")).toThrow(/mesaj/);
  });
});
