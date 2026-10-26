import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkKb, kbCheckExitCode } from "../../src/kb/check.js";
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

const ackHead = () => checkKb({ ack: checkKb().head });

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
    ackHead();
    commitIn(other, "Claude", "kb: fine");
    commitIn(other, "worker", "oops: cloud worker wrote");
    const r = checkKb();
    expect(r.foreign).toEqual([
      { sha: run(other, "T", "rev-parse", "--short", "HEAD"), author: "worker", subject: "oops: cloud worker wrote" },
    ]);
    expect(checkKb().foreign).toHaveLength(1);
    ackHead();
    expect(checkKb().foreign).toEqual([]);
  });

  it("without a marker inspects only the last 50 commits (older non-kb: history is not flagged)", () => {
    commitIn(other, "T", "legacy: pre-kb history");
    for (let i = 0; i < 52; i++) commitIn(other, "Claude", `kb: n${i}`);
    expect(checkKb().foreign).toEqual([]);
  });

  it("skips merge commits; ack <sha> does not acknowledge commits that landed after that head", () => {
    ackHead();
    run(other, "T", "checkout", "-q", "-b", "side");
    run(other, "T", "commit", "-q", "--allow-empty", "-m", "kb: side");
    run(other, "T", "checkout", "-q", "main");
    commitIn(other, "Claude", "kb: main work");
    run(other, "T", "merge", "-q", "--no-ff", "-m", "Merge branch side", "side");
    run(other, "T", "push", "-q", "origin", "HEAD");
    const first = checkKb();
    expect(first.foreign).toEqual([]);
    commitIn(other, "worker", "oops: later");
    checkKb({ ack: first.head });
    expect(checkKb().foreign.map((c) => c.subject)).toEqual(["oops: later"]);
  });

  it("network failure -> warning, no foreign commits, no throw", () => {
    run(kb, "T", "remote", "set-url", "origin", join(tmpdir(), "vlad-no-such-remote"));
    const r = checkKb();
    expect(r.foreign).toEqual([]);
    expect(r.warnings?.[0]).toMatch(/fetch/);
  });

  it("fetch failure / no upstream -> checked:false with a KONTROL YAPILAMADI warning (fail-open is visible)", () => {
    expect(checkKb().checked).toBe(true);
    run(kb, "T", "remote", "set-url", "origin", join(tmpdir(), "vlad-no-such-remote"));
    const r = checkKb();
    expect(r.checked).toBe(false);
    expect(r.warnings?.[0]).toMatch(/^KONTROL YAPILAMADI/);
    run(kb, "T", "branch", "--unset-upstream");
    const r2 = checkKb();
    expect(r2.checked).toBe(false);
    expect(r2.warnings?.[0]).toMatch(/^KONTROL YAPILAMADI/);
  });

  it("--strict exit code: 1 on foreign commits or an unchecked run, 0 otherwise; without strict always 0", () => {
    const ok = { checked: true, foreign: [], suspicious: [] };
    expect(kbCheckExitCode(ok, true)).toBe(0);
    expect(kbCheckExitCode({ ...ok, checked: false }, true)).toBe(1);
    expect(kbCheckExitCode({ ...ok, foreign: [{ sha: "a", author: "x", subject: "y" }] }, true)).toBe(1);
    expect(kbCheckExitCode({ ...ok, suspicious: [{ sha: "a", author: "x", subject: "kb: y", files: ["CLAUDE.md"] }] }, true)).toBe(1);
    expect(kbCheckExitCode({ ...ok, checked: false }, false)).toBe(0);
  });

  it("rejects --ack without a sha or with a non-hex value", () => {
    expect(() => checkKb({ ack: true })).toThrow(/sha/);
    expect(() => checkKb({ ack: "main" })).toThrow(/sha/);
    expect(() => checkKb({ ack: "abc12" })).toThrow(/sha/);
    expect(() => checkKb({ ack: "--all" })).toThrow(/sha/);
  });

  it("flags commits touching root CLAUDE.md, .claude/ or .github/ as suspicious, whatever their prefix, until acked", () => {
    ackHead();
    const touch = (cwd: string, who: string, file: string, subject: string) => {
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file), subject);
      run(cwd, who, "add", ".");
      run(cwd, who, "commit", "-q", "-m", subject);
      run(cwd, who, "push", "-q", "origin", "HEAD");
    };
    touch(other, "VLAD", "CLAUDE.md", "kb: legit-looking");
    touch(other, "VLAD", ".claude/skills/x/SKILL.md", "kb: skill");
    touch(other, "VLAD", ".github/workflows/a.yml", "kb: wf");
    touch(other, "VLAD", "docs/CLAUDE.md", "kb: nested is not root");
    const r = checkKb();
    expect(r.foreign).toEqual([]);
    expect(r.suspicious?.map((c) => [c.subject, c.files])).toEqual([
      ["kb: wf", [".github/workflows/a.yml"]],
      ["kb: skill", [".claude/skills/x/SKILL.md"]],
      ["kb: legit-looking", ["CLAUDE.md"]],
    ]);
    expect(checkKb().suspicious).toHaveLength(3);
    ackHead();
    expect(checkKb().suspicious).toEqual([]);
  });

  it("marker not an ancestor of origin (force push) -> warning, falls back to the last 50", () => {
    commitIn(other, "Claude", "kb: a");
    ackHead();
    run(other, "T", "reset", "-q", "--hard", "HEAD~1");
    run(other, "T", "commit", "-q", "--allow-empty", "-m", "kb: replaced");
    run(other, "T", "push", "-q", "--force", "origin", "HEAD");
    const r = checkKb();
    expect(r.warnings?.join(" ")).toMatch(/force/);
    expect(r.foreign).toEqual([]);
  });
});
