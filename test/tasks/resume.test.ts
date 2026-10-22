import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTask, logTask, resumeInfo, saveTask, setState } from "../../src/tasks/index.js";
import { getTask } from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}

let base: string;
let wt: string;
let id: string;

beforeEach(() => {
  makeHome();
  base = mkdtempSync(join(tmpdir(), "vlad-resume-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  id = createTask({ project: "p", title: "t", kind: "dev", body: "## Tanım\nx\n" }, new Date(2026, 9, 15)).data.id;
  wt = join(base, "wt");
  git(repo, "worktree", "add", "-b", `vlad/${id}`, wt);
});

const run = (patch: Record<string, unknown> = {}) => setState(id, "running", { branch: `vlad/${id}`, worktree: wt, ...patch });

describe("resumeInfo", () => {
  it("local: clean worktree on the right branch gives a prompt with path, warning and log tail", () => {
    run();
    for (let i = 1; i <= 7; i++) logTask(id, `adım ${i}`);
    const r = resumeInfo(id);
    if (r.mode !== "local") throw new Error("local bekleniyordu");
    expect(r).toMatchObject({ worktree: wt, branch: `vlad/${id}`, dirty: [] });
    expect(r.prompt).toContain(wt);
    expect(r.prompt).toContain("ÇALIŞMA");
    expect(r.prompt).toContain("adım 7");
    expect(r.prompt).not.toContain("adım 2");
    expect(r.log_tail).toHaveLength(5);
  });
  it("local: stalled tasks resume too; dirty tree is reported, not refused", () => {
    run();
    setState(id, "stalled");
    writeFileSync(join(wt, "new.txt"), "x");
    const r = resumeInfo(id);
    if (r.mode !== "local") throw new Error("local bekleniyordu");
    expect(r.dirty).toEqual(["new.txt"]);
    expect(r.prompt).toContain("new.txt");
  });
  it("local: wrong branch is an error", () => {
    run();
    git(wt, "checkout", "-b", "baska");
    expect(() => resumeInfo(id)).toThrow(/yanlış branch/);
  });
  it("local: missing worktree is an error", () => {
    run();
    rmSync(wt, { recursive: true, force: true });
    expect(() => resumeInfo(id)).toThrow(/worktree yok/);
  });
  it("cloud: session id gives send_message arguments", () => {
    run({ worktree: null, session_id: "session_abc" });
    const r = resumeInfo(id);
    expect(r).toMatchObject({ mode: "cloud", action: "send_message", session_id: "session_abc" });
    if (r.mode !== "cloud") throw new Error();
    expect(r.args.session_id).toBe("session_abc");
    expect(r.args.message).toContain("git status");
    expect(r.args.message).toContain(`vlad/${id}`);
  });
  it("neither worktree nor session id is an error", () => {
    run({ worktree: null });
    expect(() => resumeInfo(id)).toThrow(/sürdürülemez/);
  });
  it("unknown task and unfit states are errors", () => {
    expect(() => resumeInfo("T1")).toThrow(/görev bulunamadı/);
    expect(() => resumeInfo(id)).toThrow(/yalnızca running\/stalled/);
    run();
    setState(id, "awaiting_approval");
    expect(() => resumeInfo(id)).toThrow(/yalnızca running\/stalled/);
    saveTask(getTask(id));
  });
});
