import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNotWorker } from "../../src/mode/guard.js";
import { claudeProjectDir } from "../../src/tasks/liveness.js";
import { makeHome } from "../helpers.js";
import { runCli } from "../support/run-cli.js";

let home: string;
// F-vlad-287: mode yazma komutları cwd `vlad/T…` dalındaysa reddeder; çalışan worktree'sinde koşan testler nötr dizinde çalışır
const cwd0 = process.cwd();
beforeEach(() => { home = makeHome(); process.chdir(home); });
afterEach(() => process.chdir(cwd0));

// in-process (F-vlad-071): no child per call; stdin is unused here
const vlad = (args: string[], env: Record<string, string> = {}) => runCli(args, { env: { VLAD_HOME: home, ...env } });

describe("vlad mode", () => {
  it("night -> status (summary line carries it) -> off", async () => {
    expect((await vlad(["mode", "status"])).out).toMatch(/mod kapalı/);
    const on = (await vlad(["mode", "night", "--until", "23:59", "--projects", "vlad,ashen-bastion", "--note", "gece", "--json"]));
    expect(on.code).toBe(0);
    expect(JSON.parse(on.out).night.projects).toEqual(["vlad", "ashen-bastion"]);
    expect((await vlad(["mode", "status"])).out).toMatch(/gece modu etkin/);
    expect((await vlad(["status", "--summary"])).out).toMatch(/aktif görev.*gece modu etkin/);
    expect((await vlad(["mode", "off"])).out).toMatch(/kapalı/);
    expect((await vlad(["status", "--summary"])).out).not.toMatch(/gece modu/);
  });

  it("rejects a junk --until and a bad watch arg with exit 1", async () => {
    expect((await vlad(["mode", "night", "--until", "sabah"])).code).toBe(1);
    expect((await vlad(["mode", "watch", "maybe"])).code).toBe(1);
    expect((await vlad(["mode", "watch", "on"])).out).toMatch(/bekçi modu açık/);
  });
});

describe("vlad task idle / audit skills", () => {
  it("task idle --json lists nothing for fresh tasks; --minutes 0 lists a running one", async () => {
    const id = JSON.parse((await vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--json"])).out).id as string;
    writeFileSync(join(home, "kb", "tasks", `${id}.md`), readTask(id).replace("state: queued", "state: running"));
    expect(JSON.parse((await vlad(["task", "idle", "--json"])).out).tasks).toEqual([]);
    expect(JSON.parse((await vlad(["task", "idle", "--minutes", "0", "--json"])).out).tasks.map((t: { id: string }) => t.id)).toEqual([id]);
  });

  it("audit skills --json reads transcripts from CLAUDE_CONFIG_DIR", async () => {
    const id = JSON.parse((await vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--json"])).out).id as string;
    const wt = join(home, "wt");
    writeFileSync(join(home, "kb", "tasks", `${id}.md`), readTask(id).replace("worktree: null", `worktree: ${JSON.stringify(wt)}`));
    const cfg = mkdtempSync(join(tmpdir(), "vlad-cfg-"));
    const dir = join(cfg, "projects", claudeProjectDir(wt));
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "/s.jsonl", JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "vlad-worker" } }] } }) + "\n");
    const r = JSON.parse((await vlad(["audit", "skills", "--since", "2000-01-01", "--json"], { CLAUDE_CONFIG_DIR: cfg })).out);
    expect(r.tasks[0]).toMatchObject({ id, transcript: true, loaded: ["vlad-worker"], missing: [] });
    expect(r.summary).toMatchObject({ audited: 1, expected: 1, loaded: 1, rate: 1 });
    expect((await vlad(["audit", "skills", "--since", "nonsense"], { CLAUDE_CONFIG_DIR: cfg })).code).toBe(1);
  });
  it("F-vlad-287: mode off çalışan oturumunda (VLAD_TASK_ID) reddedilir ve pencereyi kapatmaz", async () => {
    await vlad(["mode", "night", "--until", "23:59"]);
    const r = await vlad(["mode", "off"], { VLAD_TASK_ID: "T20261112-99" });
    expect(r.code).toBe(1);
    expect((await vlad(["mode", "status"])).out).toMatch(/gece modu etkin/);
  });
  it("F-vlad-287: env temizlense de vlad/T… dalındaki (çalışan worktree'si) cwd mod yazamaz", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vlad-wk-")));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "vlad/T20261112-99");
    expect(() => assertNotWorker({}, dir)).toThrow(/çalışan/);
    git("checkout", "-q", "-b", "master");
    expect(() => assertNotWorker({}, dir)).not.toThrow();
  });
  it("F-vlad-287: env temizlenmiş + detached HEAD + dal adı değişmiş olsa da <repo>-wt/T… worktree'sinin altındaki cwd mod yazamaz", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-wk-")));
    const wt = join(root, "proj-wt", "T20261112-99");
    const sub = join(wt, "src", "x");
    mkdirSync(sub, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: wt, stdio: "pipe" });
    expect(() => assertNotWorker({}, sub)).toThrow(/çalışan/);
    expect(() => assertNotWorker({}, join(root, "proj-wt"))).not.toThrow(); // worktree kökü değil
    expect(() => assertNotWorker({}, root)).not.toThrow();
  });
  it("F-vlad-287: env -u ile worktree'den `vlad mode night` reddedilir ve pencere açılmaz", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-wk-")));
    const wt = join(root, "proj-wt", "T20261112-98");
    mkdirSync(wt, { recursive: true });
    process.chdir(wt);
    const r = await vlad(["mode", "night", "--until", "23:59"], { VLAD_TASK_ID: "" });
    expect(r.code).toBe(1);
    process.chdir(home);
    expect((await vlad(["mode", "status"])).out).toMatch(/mod kapalı/);
  });
});

import { readFileSync } from "node:fs";
const readTask = (id: string) => readFileSync(join(home, "kb", "tasks", `${id}.md`), "utf8");
