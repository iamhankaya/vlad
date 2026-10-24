import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVE_HEARTBEAT_WRITE_MS, ACTIVE_STALE_MS, activeFile, activeGuard, activeStatus, claimActive, heartbeatActive, releaseActive,
} from "../../src/active/index.js";
import { commitKb } from "../../src/kb/commit.js";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
beforeEach(() => {
  home = makeHome();
});

// "now" is injected and times are relative to it: no wall clock, no calendar dates
const NOW = 1_800_000_000_000;
const A = "winbox";
const B = "server1";
const claimAs = (machine: string, o: { takeover?: boolean; now?: number } = {}) => claimActive({ machine, now: NOW, ...o });

const vlad = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, VLAD_HOME: home, VLAD_MACHINE: B, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// `updated` is "now": `vlad status` marks old running tasks stalled
const writeTask = (id: string, state: string) => {
  const ts = new Date().toISOString();
  writeFileSync(join(home, "kb", "tasks", `${id}.md`), `---\nid: ${id}\nproject: p\ntitle: t\nkind: dev\nstate: ${state}\nautonomy: commit\ncreated: "${ts}"\nupdated: "${ts}"\n---\n\n## Tanım\nx\n`);
};

describe("records: active", () => {
  it("records: active no record -> guard passes (single-machine flow unchanged)", () => {
    expect(activeGuard("full", { now: NOW, machine: A })).toEqual([]);
    expect(existsSync(activeFile())).toBe(false);
  });

  it("records: active other machine fresh -> error active_elsewhere", () => {
    claimAs(A);
    expect(() => activeGuard("full", { now: NOW + 60_000, machine: B })).toThrow(/^active_elsewhere/);
    expect(() => claimAs(B, { now: NOW + 60_000 })).toThrow(/active_elsewhere/);
    // own machine is never blocked
    expect(activeGuard("full", { now: NOW + 60_000, machine: A })).toEqual([]);
  });

  it("records: stale warns and continues (threshold +-1s)", () => {
    claimAs(A);
    const guard = (dt: number) => activeGuard("full", { now: NOW + dt, machine: B });
    expect(() => guard(ACTIVE_STALE_MS - 1000)).toThrow(/active_elsewhere/);
    const w = guard(ACTIVE_STALE_MS); // exactly at the threshold counts as stale
    expect(w.join(" ")).toMatch(/bayat/);
    expect(guard(ACTIVE_STALE_MS + 1000).join(" ")).toMatch(/bayat/);
    // a stale record can be claimed without --takeover, with a warning
    const r = claimAs(B, { now: NOW + ACTIVE_STALE_MS + 1000 });
    expect(r.record.takeover_from).toBe(A);
    expect(r.warnings.join(" ")).toMatch(/bayat/);
  });

  it("records: heartbeat in the future (clock skew) counts as fresh", () => {
    claimAs(A, { now: NOW + 10 * 60_000 }); // writer's clock is 10 min ahead
    expect(activeStatus({ now: NOW, machine: B }).stale).toBe(false);
    expect(() => activeGuard("full", { now: NOW, machine: B })).toThrow(/active_elsewhere/);
  });

  it("records: takeover refreshes", () => {
    claimAs(A);
    const t = NOW + 5 * 60_000;
    const r = claimAs(B, { takeover: true, now: t });
    expect(r.record.machine).toBe(B);
    expect(r.record.takeover_from).toBe(A);
    expect(Date.parse(r.record.since)).toBe(t);
    expect(Date.parse(r.record.heartbeat)).toBe(t);
  });

  it("records: other machine drops to read-only after takeover", () => {
    claimAs(A);
    claimAs(B, { takeover: true, now: NOW + 1000 });
    expect(() => activeGuard("full", { now: NOW + 2000, machine: A })).toThrow(/active_elsewhere/);
    expect(() => heartbeatActive({ now: NOW + 2000, machine: A })).toThrow(/active_elsewhere/);
    expect(() => releaseActive({ now: NOW + 2000, machine: A })).toThrow(/active_elsewhere/);
    expect(activeStatus({ machine: B, now: NOW + 2000 }).record?.machine).toBe(B);
  });

  it("records: heartbeat writes at most every 30 min (+-1s)", () => {
    claimAs(A);
    expect(heartbeatActive({ now: NOW + ACTIVE_HEARTBEAT_WRITE_MS - 1000, machine: A }).written).toBe(false);
    expect(heartbeatActive({ now: NOW + ACTIVE_HEARTBEAT_WRITE_MS, machine: A }).written).toBe(true);
  });

  it("records: release by owner removes the record; none is a no-op", () => {
    expect(releaseActive({ machine: A })).toBe(false);
    claimAs(A);
    expect(releaseActive({ now: NOW, machine: A })).toBe(true);
    expect(existsSync(activeFile())).toBe(false);
  });

  it("records: corrupt active.md is ignored with a warning, not a lock-out", () => {
    writeFileSync(activeFile(), "---\nmachine: [\n---\n");
    const st = activeStatus({ now: NOW, machine: A });
    expect(st.record).toBeNull();
    expect(st.warnings.length).toBe(1);
    expect(activeGuard("full", { now: NOW, machine: A })).toHaveLength(1);
  });

  it("records: worker exemption requires running task file (fake env var alone not enough)", () => {
    claimAs(A);
    const at = NOW + 1000;
    const guard = (env: Record<string, string>, taskId?: string) => () => activeGuard("worker", { now: at, machine: B, env, taskId });
    // fake variable, no task file
    expect(guard({ VLAD_TASK_ID: "T20261024-108" }, "T20261024-108")).toThrow(/active_elsewhere/);
    // task file exists but is not running
    writeTask("T20261024-108", "awaiting_approval");
    expect(guard({ VLAD_TASK_ID: "T20261024-108" }, "T20261024-108")).toThrow(/active_elsewhere/);
    // running: passes, but only for the task the variable names
    writeTask("T20261024-108", "running");
    expect(guard({ VLAD_TASK_ID: "T20261024-108" }, "T20261024-108")()).toEqual([]);
    expect(guard({ VLAD_TASK_ID: "T20261024-108" }, "T20261024-99")).toThrow(/active_elsewhere/);
    // full mode never exempts; path-shaped ids never resolve
    expect(() => activeGuard("full", { now: at, machine: B, env: { VLAD_TASK_ID: "T20261024-108" } })).toThrow(/active_elsewhere/);
    expect(guard({ VLAD_TASK_ID: "../tasks/T20261024-108" }, "../tasks/T20261024-108")).toThrow(/active_elsewhere/);
  });

  it("records: concurrent claim one wins", async () => {
    const run = (machine: string) =>
      new Promise<{ code: number | null; err: string }>((res) => {
        const p = spawn("node", [cli, "active", "claim", "--json"], { env: { ...process.env, VLAD_HOME: home, VLAD_MACHINE: machine } });
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => res({ code, err }));
      });
    const results = await Promise.all(["m-a", "m-b", "m-c", "m-d"].map(run));
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    for (const r of results.filter((r) => r.code !== 0)) expect(JSON.parse(r.err).error).toMatch(/^active_elsewhere/);
    const winner = readFileSync(activeFile(), "utf8").match(/machine: (\S+)/)![1];
    expect(["m-a", "m-b", "m-c", "m-d"]).toContain(winner);
  });

  it("records: two clones both claim -> second push rejected, remote keeps first record", () => {
    const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" });
    const root = mkdtempSync(join(tmpdir(), "vlad-s4b-git-"));
    const bare = join(root, "remote.git");
    sh(root, "init", "-q", "--bare", "-b", "main", bare);
    const clone = (name: string) => {
      const dir = join(root, name);
      sh(root, "clone", "-q", bare, dir);
      sh(dir, "config", "user.email", "t@t");
      sh(dir, "config", "user.name", "t");
      return dir;
    };
    const first = clone("first");
    mkdirSync(join(first, "kb"));
    writeFileSync(join(first, "kb", ".keep"), "");
    sh(first, "add", "."); sh(first, "commit", "-q", "-m", "init"); sh(first, "push", "-q", "-u", "origin", "main");
    const second = clone("second");
    // each clone is a VLAD home of its own machine
    const asHome = (dir: string, machine: string) => {
      process.env.VLAD_HOME = dir;
      mkdirSync(join(dir, "kb"), { recursive: true });
      claimActive({ machine, now: NOW });
      return commitKb(`active ${machine}`, { push: true });
    };
    expect(asHome(first, A).pushed).toBe(true);
    expect(() => asHome(second, B)).toThrow(/push/);
    expect(sh(bare, "show", "main:kb/active.md")).toContain(`machine: ${A}`);
  });

  it("records: cli guard blocks write commands on a fresh other machine; reads and worker commands pass", () => {
    writeTask("T20261024-108", "running");
    expect(vlad(["active", "claim"], { VLAD_MACHINE: A }).code).toBe(0);
    const w = vlad(["quota", "set", "--until", "2999-01-01T00:00:00+00:00", "--reason", "x", "--json"]);
    expect(w.code).toBe(1);
    expect(JSON.parse(w.err).error).toMatch(/^active_elsewhere/);
    expect(vlad(["quota", "show"]).code).toBe(0);
    expect(vlad(["active", "show", "--json"]).code).toBe(0);
    expect(vlad(["status", "--summary"]).code).toBe(0);
    // worker log works with a running task; a fake id does not
    const ok = vlad(["task", "log", "T20261024-108", "adım"], { VLAD_TASK_ID: "T20261024-108" });
    expect(ok.err).toBe("");
    expect(ok.code).toBe(0);
    expect(vlad(["task", "log", "T20261024-108", "adım"], { VLAD_TASK_ID: "T20261024-77" }).code).toBe(1);
    // non-worker command with the variable set is still blocked
    expect(vlad(["quota", "clear"], { VLAD_TASK_ID: "T20261024-108" }).code).toBe(1);
    // takeover from the second machine
    expect(vlad(["active", "claim", "--takeover"]).code).toBe(0);
    expect(vlad(["quota", "clear"], { VLAD_MACHINE: A }).code).toBe(1);
  });
});
