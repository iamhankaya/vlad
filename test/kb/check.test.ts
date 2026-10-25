import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkKb } from "../../src/kb/check.js";
import { makeHome } from "../helpers.js";

const ident = (n: string) => ({
  GIT_AUTHOR_NAME: n, GIT_AUTHOR_EMAIL: `${n}@t`, GIT_COMMITTER_NAME: n, GIT_COMMITTER_EMAIL: `${n}@t`,
});
let remote: string;
let kb: string;
let other: string; // second clone: plays "VLAD on another machine" or a foreign writer
const run = (cwd: string, who: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...ident(who) } }).trim();
const commitIn = (cwd: string, who: string, subject: string) => {
  writeFileSync(join(cwd, `f-${Math.random().toString(36).slice(2)}.md`), subject);
  run(cwd, who, "add", ".");
  run(cwd, who, "commit", "-q", "-m", subject);
  run(cwd, who, "push", "-q", "origin", "HEAD");
};

beforeEach(() => {
  const home = makeHome();
  remote = mkdtempSync(join(tmpdir(), "vlad-kbremote-"));
  run(remote, "T", "init", "--bare", "-b", "main");
  kb = mkdtempSync(join(tmpdir(), "vlad-kbclone-"));
  other = mkdtempSync(join(tmpdir(), "vlad-kbother-"));
  run(kb, "T", "init", "-b", "main");
  run(kb, "T", "remote", "add", "origin", remote);
  commitIn(kb, "T", "kb: init");
  run(kb, "T", "push", "-q", "-u", "origin", "main");
  run(other, "T", "clone", "-q", remote, ".");
  process.env.VLAD_KB_DIR = kb;
  void home;
});

describe("checkKb", () => {
  it("only kb: commits after the last verified point -> empty, marker advances", () => {
    expect(checkKb().foreign).toEqual([]);
    commitIn(other, "Claude", "kb: status: T1 done");
    commitIn(other, "VLAD", "kb: delegate: T2");
    run(kb, "T", "pull", "-q");
    const r = checkKb();
    expect(r.foreign).toEqual([]);
    expect(readFileSync(join(kb, ".git", "vlad-kb-verified"), "utf8").trim()).toBe(run(kb, "T", "rev-parse", "origin/main"));
  });

  it("lists a commit without the kb: prefix, with sha/author/subject, and keeps listing it until --ack", () => {
    checkKb({ ack: true });
    commitIn(other, "Claude", "kb: fine");
    commitIn(other, "worker", "oops: cloud worker wrote");
    const r = checkKb();
    expect(r.foreign).toEqual([
      { sha: run(other, "T", "rev-parse", "--short", "HEAD"), author: "worker", subject: "oops: cloud worker wrote" },
    ]);
    expect(checkKb().foreign).toHaveLength(1);
    checkKb({ ack: true });
    expect(checkKb().foreign).toEqual([]);
  });

  it("without a marker inspects only the last 50 commits (older non-kb: history is not flagged)", () => {
    commitIn(other, "T", "legacy: pre-kb history");
    for (let i = 0; i < 52; i++) commitIn(other, "Claude", `kb: n${i}`);
    expect(checkKb().foreign).toEqual([]);
  });

  it("network failure -> warning, no foreign commits, no throw", () => {
    run(kb, "T", "remote", "set-url", "origin", join(tmpdir(), "vlad-no-such-remote"));
    const r = checkKb();
    expect(r.foreign).toEqual([]);
    expect(r.warnings?.[0]).toMatch(/fetch/);
  });

  it("marker not an ancestor of origin (force push) -> warning, falls back to the last 50", () => {
    commitIn(other, "Claude", "kb: a");
    checkKb({ ack: true });
    run(other, "T", "reset", "-q", "--hard", "HEAD~1");
    run(other, "T", "commit", "-q", "--allow-empty", "-m", "kb: replaced");
    run(other, "T", "push", "-q", "--force", "origin", "HEAD");
    const r = checkKb();
    expect(r.warnings?.join(" ")).toMatch(/force/);
    expect(r.foreign).toEqual([]);
  });
});
