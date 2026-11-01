import { describe, expect, it } from "vitest";
import type { TaskData, VladConfig } from "../../src/kb/index.js";
import type { Task } from "../../src/tasks/store.js";
import { defaultConfig } from "../../src/kb/index.js";
import { RESERVATION_TTL_MS, capsOf, machineLoad, pickMachine, simulateReady } from "../../src/machines/placement.js";

const NOW = 1_800_000_000_000; // fixed "now"; every other time is NOW ± delta
const iso = (ms: number) => new Date(ms).toISOString();
let n = 0;
const task = (o: Partial<TaskData> = {}): Task => ({
  file: "", body: "",
  data: { id: `T${++n}`, project: "p", title: "t", kind: "dev", state: "queued", autonomy: "commit", branch: null, worktree: null, session_id: null, created: "", updated: "", error: null, depends_on: [], ...o } as TaskData,
});
const cfg = (extra: Partial<VladConfig> = {}): VladConfig => ({
  ...defaultConfig(), brain: "mac",
  machines: [
    { name: "mac", os: "darwin", agent: { port: 7437 }, maxParallel: 1 },
    { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, maxParallel: 1 },
  ], ...extra,
});
const cards = (m: Record<string, string[] | undefined>) => (p: string) => ({ machines: m[p] });

describe("machines:A machineLoad", () => {
  it("counts running dev tasks by machine (absent -> brain); blocked/stalled/research/pipeline do not count", () => {
    const { load } = machineLoad([
      task({ state: "running" }), task({ state: "running", machine: "windows" }),
      task({ state: "blocked" }), task({ state: "stalled", machine: "windows" }),
      task({ state: "running", kind: "research" }), task({ state: "running", kind: "pipeline" }),
    ], "mac", NOW);
    expect(load).toEqual({ mac: 1, windows: 1 });
  });
  it("a fresh reservation counts; an expired brain reservation does not; an expired remote one still does and both are listed", () => {
    const fresh = task({ machine: "windows", machine_reserved: iso(NOW - 60_000), launch_op: "a" });
    const staleLocal = task({ machine: "mac", machine_reserved: iso(NOW - RESERVATION_TTL_MS - 60_000), launch_op: "b" });
    const staleRemote = task({ machine: "windows", machine_reserved: iso(NOW - 11 * 60_000), launch_op: "c" });
    const r = machineLoad([fresh, staleLocal, staleRemote], "mac", NOW);
    expect(r.load).toEqual({ windows: 2 });
    expect(r.expired).toEqual([staleLocal.data.id, staleRemote.data.id]);
  });
  it("a running task with a leftover reservation is counted once", () => {
    const t = task({ state: "running", machine: "windows", machine_reserved: iso(NOW), launch_op: "x" });
    expect(machineLoad([t], "mac", NOW).load).toEqual({ windows: 1 });
  });
});

describe("machines:A pickMachine", () => {
  it("first candidate with a free slot wins", async () => {
    expect(await pickMachine(["mac", "windows"], { mac: 0 }, { mac: 1, windows: 1 })).toEqual({ machine: "mac" });
  });
  it("K1: mac full -> windows", async () => {
    expect(await pickMachine(["mac", "windows"], { mac: 1 }, { mac: 1, windows: 1 })).toEqual({ machine: "windows" });
  });
  it("K2: [windows] full -> held 'dolu', reach is never called for a full candidate", async () => {
    let pings = 0;
    const r = await pickMachine(["windows"], { windows: 1 }, { windows: 1 }, () => { pings++; return true; });
    expect(r).toEqual({ machine: null, reasons: [{ machine: "windows", reason: "dolu" }] });
    expect(pings).toBe(0);
  });
  it("K3: an unreachable candidate is skipped (reason 'erişilemez') after exactly one reach call", async () => {
    let pings = 0;
    const r = await pickMachine(["windows", "mac"], {}, { windows: 1, mac: 1 }, async (m) => { pings++; return m !== "windows"; });
    expect(r).toEqual({ machine: "mac" });
    expect(pings).toBe(2);
    pings = 0;
    const held = await pickMachine(["windows"], {}, { windows: 1 }, () => { pings++; return false; });
    expect(held).toEqual({ machine: null, reasons: [{ machine: "windows", reason: "erişilemez" }] });
    expect(pings).toBe(1);
  });
  it("no cap (undefined) means unlimited", async () => {
    expect(await pickMachine(["mac"], { mac: 50 }, {})).toEqual({ machine: "mac" });
  });
  it("candidates after the winner are not probed", async () => {
    const seen: string[] = [];
    await pickMachine(["mac", "windows"], {}, {}, (m) => { seen.push(m); return true; });
    expect(seen).toEqual(["mac"]);
  });
});

describe("machines:A capsOf", () => {
  it("machine maxParallel, else the global maxParallel, else unlimited", () => {
    const c = cfg({ maxParallel: 3 });
    c.machines![1] = { name: "windows", os: "win32", agent: { host: "h", port: 7437 } };
    expect(capsOf(c)).toEqual({ mac: 1, windows: 3 });
    const d = cfg();
    d.machines![0] = { name: "mac", os: "darwin", agent: { port: 7437 } };
    expect(capsOf(d)).toEqual({ mac: undefined, windows: 1 });
  });
});

describe("machines:A simulateReady", () => {
  it("places in order and consumes slots inside the batch (one slot each)", () => {
    const a = task(), b = task(), c = task();
    const r = simulateReady([a, b, c], [a, b, c], cfg(), cards({ p: ["mac", "windows"] }), NOW);
    expect(r.placements).toEqual([{ id: a.data.id, machine: "mac" }, { id: b.data.id, machine: "windows" }]);
    expect(r.held).toEqual([{ id: c.data.id, reasons: [{ machine: "mac", reason: "dolu" }, { machine: "windows", reason: "dolu" }] }]);
  });
  it("K1/K2: mac busy -> [mac,windows] goes to windows; [windows] never to mac and is held when windows is taken", () => {
    const run = task({ state: "running", project: "q" });
    const x = task({ project: "p" }), y = task({ project: "w" });
    const r = simulateReady([x, y], [run, x, y], cfg(), cards({ p: ["mac", "windows"], w: ["windows"] }), NOW);
    expect(r.placements).toEqual([{ id: x.data.id, machine: "windows" }]);
    expect(r.held).toEqual([{ id: y.data.id, reasons: [{ machine: "windows", reason: "dolu" }] }]);
  });
  it("card without machines -> [brain]", () => {
    const a = task();
    expect(simulateReady([a], [a], cfg(), cards({}), NOW).placements).toEqual([{ id: a.data.id, machine: "mac" }]);
  });
  it("undefined machine names are skipped with a warning; all-undefined -> held 'tanımsız'", () => {
    const a = task({ project: "p" }), b = task({ project: "q" });
    const r = simulateReady([a, b], [a, b], cfg(), cards({ p: ["gone", "windows"], q: ["gone"] }), NOW);
    expect(r.placements).toEqual([{ id: a.data.id, machine: "windows" }]);
    expect(r.held).toEqual([{ id: b.data.id, reasons: [{ machine: "gone", reason: "tanımsız" }] }]);
    expect(r.warnings.join("\n")).toMatch(/gone/);
  });
  it("pipeline pinned to a machine: phases go only there, held when it is full", () => {
    const pipe = task({ kind: "pipeline", machine: "windows" });
    const busy = task({ state: "running", machine: "windows", project: "z" });
    const ph = task({ parent: pipe.data.id });
    const r = simulateReady([ph], [pipe, busy, ph], cfg(), cards({ p: ["mac", "windows"] }), NOW);
    expect(r.placements).toEqual([]);
    expect(r.held).toEqual([{ id: ph.data.id, reasons: [{ machine: "windows", reason: "dolu" }] }]);
  });
  it("pipeline not yet pinned: the first placed phase pins its siblings in the same batch", () => {
    const pipe = task({ kind: "pipeline" });
    const a = task({ parent: pipe.data.id }), b = task({ parent: pipe.data.id });
    const c = cfg();
    c.machines![0] = { ...c.machines![0], maxParallel: 5 };
    const r = simulateReady([a, b], [pipe, a, b], c, cards({ p: ["mac", "windows"] }), NOW);
    expect(r.placements.map((p) => p.machine)).toEqual(["mac", "mac"]);
  });
  it("a queued task holding a fresh reservation counts toward its machine", () => {
    const res = task({ machine: "windows", machine_reserved: iso(NOW - 1000), launch_op: "u", project: "z" });
    const a = task();
    const r = simulateReady([a], [res, a], cfg(), cards({ p: ["windows"] }), NOW);
    expect(r.held[0].reasons).toEqual([{ machine: "windows", reason: "dolu" }]);
  });
});
