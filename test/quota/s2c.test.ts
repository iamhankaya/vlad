import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { kbPaths } from "../../src/kb/index.js";
import { createTask, setState, readyWithLimit } from "../../src/tasks/index.js";
import { clearQuota, quotaFile, readQuota, setQuota } from "../../src/quota/index.js";

const D = new Date(2026, 9, 15, 10, 0, 0);
const mk = (title: string) => createTask({ project: "p", title, kind: "dev", body: "## Tanım\nx\n" }, D);
const future = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();
const past = () => new Date(Date.now() - 3_600_000).toISOString();
const write = (s: string) => { mkdirSync(kbPaths().logs, { recursive: true }); writeFileSync(quotaFile(), s, "utf8"); };

beforeEach(() => { makeHome(); });

describe("tasks: quota", () => {
  it("tasks: quota holds all ready as held_by_limit reason quota", () => {
    mk("a"); mk("b");
    const until = future();
    const r = readyWithLimit({}, undefined, { limited: true, until });
    expect(r.tasks).toEqual([]);
    expect(r.held_by_limit).toHaveLength(2);
    expect(Object.values(r.held_reasons)).toEqual(["quota", "quota"]);
    expect(r.quota).toEqual({ limited: true, until });
  });
  it("tasks: quota expired clears", () => {
    mk("a");
    setQuota(past(), "T1");
    const { quota } = readQuota();
    expect(quota.limited).toBe(false);
    expect(readyWithLimit({}, undefined, quota).tasks).toHaveLength(1);
    setQuota(future(), "T1");
    expect(readQuota().quota.limited).toBe(true);
    expect(readQuota(Date.now() + 2 * 3_600_000).quota.limited).toBe(false);
    expect(clearQuota()).toBe(true);
    expect(clearQuota()).toBe(false);
    expect(readQuota().quota.limited).toBe(false);
  });
  it("tasks: quota beats maxParallel reason", () => {
    const a = mk("a"); mk("b"); mk("c");
    setState(a.data.id, "running");
    // maxParallel alone: 1 running of 2 -> one free slot, one held with reason limit
    const free = readyWithLimit({}, 2, { limited: false });
    expect(free.tasks).toHaveLength(1);
    expect(Object.values(free.held_reasons)).toEqual(["limit"]);
    // quota on top: nothing starts, even though a slot is free; reason is quota
    const q = readyWithLimit({}, 2, { limited: true });
    expect(q.tasks).toEqual([]);
    expect(Object.values(q.held_reasons)).toEqual(["quota", "quota"]);
    expect(q.maxParallel).toBe(2);
  });
  it("tasks: no quota argument keeps the old behaviour", () => {
    mk("a"); mk("b");
    const r = readyWithLimit({}, 1);
    expect(r.tasks).toHaveLength(1);
    expect(r.held_by_limit).toHaveLength(1);
    expect(r.quota).toEqual({ limited: false });
  });
  it("tasks: corrupt or empty quota.json treated as none with warning", () => {
    for (const body of ["", "  \n", "{not json", "[]", "null", '{"limited_until":"yarın"}', '{"limited_until":5}']) {
      write(body);
      const r = readQuota();
      expect(r.quota.limited, body).toBe(false);
      expect(r.warnings, body).toHaveLength(1);
    }
  });
  it("tasks: missing quota.json is no limit without warning", () => {
    const r = readQuota();
    expect(r).toEqual({ quota: { limited: false }, record: null, warnings: [] });
  });
  it("tasks: unknown reason ignored", () => {
    write(JSON.stringify({ limited_until: future(), reason: "bilinmeyen-neden", at: "x" }));
    const r = readQuota();
    expect(r.quota.limited).toBe(true);
    expect(r.warnings).toEqual([]);
    write(JSON.stringify({ limited_until: future(), reason: 42 }));
    expect(readQuota().quota.limited).toBe(true);
  });
  it("tasks: setQuota rejects a bad --until or empty reason", () => {
    expect(() => setQuota("yarın", "T")).toThrow(/geçersiz --until/);
    expect(() => setQuota("2026-13-45T99:00:00Z", "T")).toThrow(/geçersiz --until/);
    expect(() => setQuota(future(), " ")).toThrow(/reason/);
  });
});

describe("cli: quota", () => {
  const cli = join(import.meta.dirname, "..", "..", "dist", "cli.js");
  const vlad = (...args: string[]) => {
    const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: process.env });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  it("set/show/clear and ready --json shape (old fields kept, reason added)", () => {
    mk("a");
    const until = future();
    expect(vlad("quota", "set", "--until", until, "--reason", "T1").code).toBe(0);
    const show = JSON.parse(vlad("quota", "show", "--json").out);
    expect(show).toMatchObject({ limited: true, until, reason: "T1" });
    const ready = JSON.parse(vlad("task", "ready", "--json").out);
    expect(Object.keys(ready)).toEqual(expect.arrayContaining(["tasks", "held_by_limit", "running", "maxParallel"]));
    expect(ready.tasks).toEqual([]);
    expect(ready.held_by_limit[0]).toMatchObject({ title: "a", state: "queued", reason: "quota" });
    expect(ready.quota).toEqual({ limited: true, until });
    expect(vlad("quota", "clear").code).toBe(0);
    const after = JSON.parse(vlad("task", "ready", "--json").out);
    expect(after.tasks).toHaveLength(1);
    expect(after.quota.limited).toBe(false);
    expect(vlad("quota", "set", "--until", "yarın", "--reason", "T").code).toBe(1);
  }, 60_000);
});
