import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeProjectDir } from "../../src/tasks/liveness.js";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
beforeEach(() => { home = makeHome(); });

function vlad(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, VLAD_HOME: home, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("vlad mode", () => {
  it("night -> status (summary line carries it) -> off", () => {
    expect(vlad(["mode", "status"]).out).toMatch(/mod kapalı/);
    const on = vlad(["mode", "night", "--until", "23:59", "--projects", "vlad,ashen-bastion", "--note", "gece", "--json"]);
    expect(on.code).toBe(0);
    expect(JSON.parse(on.out).night.projects).toEqual(["vlad", "ashen-bastion"]);
    expect(vlad(["mode", "status"]).out).toMatch(/gece modu etkin/);
    expect(vlad(["status", "--summary"]).out).toMatch(/aktif görev.*gece modu etkin/);
    expect(vlad(["mode", "off"]).out).toMatch(/kapalı/);
    expect(vlad(["status", "--summary"]).out).not.toMatch(/gece modu/);
  });

  it("rejects a junk --until and a bad watch arg with exit 1", () => {
    expect(vlad(["mode", "night", "--until", "sabah"]).code).toBe(1);
    expect(vlad(["mode", "watch", "maybe"]).code).toBe(1);
    expect(vlad(["mode", "watch", "on"]).out).toMatch(/bekçi modu açık/);
  });
});

describe("vlad task idle / audit skills", () => {
  it("task idle --json lists nothing for fresh tasks; --minutes 0 lists a running one", () => {
    const id = JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--json"]).out).id as string;
    writeFileSync(join(home, "kb", "tasks", `${id}.md`), readTask(id).replace("state: queued", "state: running"));
    expect(JSON.parse(vlad(["task", "idle", "--json"]).out).tasks).toEqual([]);
    expect(JSON.parse(vlad(["task", "idle", "--minutes", "0", "--json"]).out).tasks.map((t: { id: string }) => t.id)).toEqual([id]);
  });

  it("audit skills --json reads transcripts from CLAUDE_CONFIG_DIR", () => {
    const id = JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--json"]).out).id as string;
    const wt = join(home, "wt");
    writeFileSync(join(home, "kb", "tasks", `${id}.md`), readTask(id).replace("worktree: null", `worktree: ${JSON.stringify(wt)}`));
    const cfg = mkdtempSync(join(tmpdir(), "vlad-cfg-"));
    const dir = join(cfg, "projects", claudeProjectDir(wt));
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "/s.jsonl", JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "vlad-worker" } }] } }) + "\n");
    const r = JSON.parse(vlad(["audit", "skills", "--since", "2000-01-01", "--json"], { CLAUDE_CONFIG_DIR: cfg }).out);
    expect(r.tasks[0]).toMatchObject({ id, transcript: true, loaded: ["vlad-worker"], missing: [] });
    expect(r.summary).toMatchObject({ audited: 1, expected: 1, loaded: 1, rate: 1 });
    expect(vlad(["audit", "skills", "--since", "nonsense"], { CLAUDE_CONFIG_DIR: cfg }).code).toBe(1);
  });
});

import { readFileSync } from "node:fs";
const readTask = (id: string) => readFileSync(join(home, "kb", "tasks", `${id}.md`), "utf8");
