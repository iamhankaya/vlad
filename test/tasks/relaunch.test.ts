import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { buildShellScript } from "../../src/launcher/index.js";
import { readQuota } from "../../src/quota/index.js";
import { writeProject } from "../../src/projects/store.js";
import {
  answerTask, askTask, createTask, getTask, launchTask, relaunchTask, saveTask, setState, tapStream, workerLogFile,
} from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}
const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "..", "..", "contract", "fixtures", "external", "claude-stream-json", name), "utf8");

let repo: string;
let cfg: VladConfig;
const fake = (): Launcher & { reqs: LaunchRequest[] } => {
  const reqs: LaunchRequest[] = [];
  return { reqs, async launch(r) { reqs.push(r); return { ok: true, method: "fake" }; } };
};
const SID = "00000000-0000-4000-8000-000000000005";

beforeEach(() => {
  makeHome();
  process.env.VLAD_MACHINE = "srv-a";
  const base = mkdtempSync(join(tmpdir(), "vlad-relaunch-"));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  cfg = defaultConfig();
  cfg.worktreeDir = join(base, "wt");
  writeProject("alpha", `---
slug: alpha
name: Alpha
path: ${JSON.stringify(repo)}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`);
});

const running = async (l = fake()) => {
  const t = createTask({ project: "alpha", title: "iş", kind: "dev", body: "## Tanım\nx\n" });
  await launchTask(t.data.id, { launcher: l, cfg });
  return t.data.id;
};
const setSid = (id: string, sid: string | null) => { const t = getTask(id); t.data.session_id = sid; saveTask(t); };

describe("tasks: relaunch", () => {
  it("tasks: relaunch without session_id explicit error", async () => {
    const id = await running();
    await expect(relaunchTask(id, { launcher: fake() })).rejects.toThrow(/session_id kayıtlı değil/);
  });
  it("tasks: relaunch on other host rejected", async () => {
    const id = await running();
    setSid(id, SID);
    process.env.VLAD_MACHINE = "srv-b";
    const l = fake();
    await expect(relaunchTask(id, { launcher: l })).rejects.toThrow(/başka makinede.*srv-a.*srv-b/);
    expect(l.reqs).toHaveLength(0);
  });
  it("tasks: ask exits blocked then answer then relaunch resumes", async () => {
    const l = fake();
    const id = await running(l);
    expect(l.reqs[0].tap).toBe(true); // first launch is tapped, so session_id will be recorded
    // worker output: tap records the session id and last step
    await tapStream(id, Readable.from([fixture("ask-turn.jsonl")]));
    expect(getTask(id).data.session_id).toBe(SID);
    expect(getTask(id).data.progress?.label).toContain("[VLAD:ASK #1]");
    askTask(id, "A mı B mi?");
    expect(getTask(id).data.state).toBe("blocked");
    // blocked has no process: relaunch refuses until the answer is in
    await expect(relaunchTask(id, { launcher: l })).rejects.toThrow(/önce `vlad task answer`/);
    answerTask(id, "B olsun");
    expect(getTask(id).data.state).toBe("running");
    const t = await relaunchTask(id, { launcher: l });
    expect(t.data.state).toBe("running");
    const req = l.reqs[1];
    expect(req.resumeSessionId).toBe(SID);
    expect(req.tap).toBe(true);
    expect(req.cwd).toBe(getTask(id).data.worktree);
    expect(req.prompt).toContain("B olsun");
  });
  it("tasks: relaunch of a stalled task moves it back to running", async () => {
    const id = await running();
    setSid(id, SID);
    setState(id, "stalled");
    expect((await relaunchTask(id, { launcher: fake() })).data.state).toBe("running");
  });
  it("tasks: relaunch refuses non running/stalled states", async () => {
    const id = await running();
    setSid(id, SID);
    setState(id, "awaiting_approval");
    await expect(relaunchTask(id, { launcher: fake() })).rejects.toThrow(/running\/stalled/);
  });
  it("tasks: launcher failure on relaunch leaves the state alone", async () => {
    const id = await running();
    setSid(id, SID);
    const bad: Launcher = { launch: async () => ({ ok: false, method: "process", detail: "boom" }) };
    await expect(relaunchTask(id, { launcher: bad })).rejects.toThrow(/boom/);
    expect(getTask(id).data.state).toBe("running");
  });
  it("tasks: argument injection safe (value starting with - and ;)", async () => {
    const id = await running();
    const l = fake();
    for (const bad of ["-p", "--dangerously-skip-permissions", "abc12345; rm -rf ~", "$(id)abcdef", "a b c d e f g h"]) {
      setSid(id, bad);
      await expect(relaunchTask(id, { launcher: l })).rejects.toThrow(/session_id geçersiz/);
      expect(() => buildShellScript({ taskId: id, cwd: "/w", prompt: "x", env: {}, title: "t", resumeSessionId: bad }, "/p", "/s", { PATH: "/bin", HOME: "/h" }))
        .toThrow(/geçersiz session_id/);
    }
    expect(l.reqs).toHaveLength(0);
    // the launch script quotes the id and tees through the tap
    const s = buildShellScript({ taskId: id, cwd: "/w", prompt: "x", env: {}, title: "t", resumeSessionId: SID, tap: true }, "/p", "/s", { PATH: "/bin", HOME: "/h" });
    expect(s).toContain(`--resume '${SID}'`);
    expect(s).toContain(`| vlad worker tap '${id}'`);
    expect(s).not.toMatch(/^exec /m);
  });
});

describe("launcher: tap into the kb", () => {
  it("launcher: limit event writes quota", async () => {
    const id = await running();
    const now = new Date(1792899000 * 1000 - 3_600_000); // an hour before the synthetic reset
    await tapStream(id, Readable.from([fixture("limit-event.synthetic.jsonl")]), { now: () => now });
    const q = readQuota(now.getTime());
    expect(q.quota).toEqual({ limited: true, until: new Date(1792899000 * 1000).toISOString() });
    expect(q.record?.reason).toContain(id);
  });
  it("launcher: tap keeps the raw lines in the worker log and survives a bad batch", async () => {
    const id = await running();
    const warns: string[] = [];
    await tapStream(id, Readable.from([fixture("single-turn.jsonl")]), { warn: (m) => warns.push(m) });
    expect(existsSync(workerLogFile(id))).toBe(true);
    expect(readFileSync(workerLogFile(id), "utf8")).toContain('"type": "result"');
    expect(warns).toEqual([]);
    expect(() => workerLogFile("../x")).toThrow(/geçersiz görev kimliği/);
  });
});
