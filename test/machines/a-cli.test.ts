import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getTask, saveTask } from "../../src/tasks/store.js";
import { NO_CLOUD_ENV, newTask, vlad as run, writeCard } from "../acceptance/cloud-helpers.js";
import { makeHome } from "../helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });
const vlad = (args: string[]) => run(home, args, { env: NO_CLOUD_ENV });
const json = (args: string[]) => {
  const r = vlad([...args, "--json"]);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out);
};
const cfg = (o: object) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify(o));
const MACHINES = {
  brain: "mac",
  machines: [
    { name: "mac", os: "darwin", agent: { port: 7437 }, maxParallel: 1 },
    { name: "windows", os: "win32", agent: { host: "192.168.1.20", port: 7437 }, maxParallel: 1 },
  ],
};
const setTask = (id: string, patch: object) => {
  const t = getTask(id);
  t.data = { ...t.data, ...patch };
  saveTask(t);
};

describe("machines:A project set machines", () => {
  beforeEach(() => { writeCard(home, "alpha"); cfg(MACHINES); });
  it("writes the ordered list into the card and keeps the rest", () => {
    expect(json(["project", "set", "alpha", "machines", "mac, windows"])).toMatchObject({ slug: "alpha", field: "machines" });
    const card = readFileSync(join(home, "kb", "projects", "alpha.md"), "utf8");
    expect(card).toMatch(/machines:\n\s*- mac\n\s*- windows/);
    expect(json(["project", "list"]).projects[0].machines).toEqual(["mac", "windows"]);
    expect(card).toContain("slug: alpha");
  });
  it("a machine not defined in config is rejected by name", () => {
    const r = vlad(["project", "set", "alpha", "machines", "mac,ghost"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("config'te tanımlı değil: ghost");
  });
  it("duplicate names are rejected; empty value removes the field", () => {
    expect(vlad(["project", "set", "alpha", "machines", "mac,mac"]).code).toBe(1);
    vlad(["project", "set", "alpha", "machines", "windows"]);
    vlad(["project", "set", "alpha", "machines", ""]);
    expect(readFileSync(join(home, "kb", "projects", "alpha.md"), "utf8")).not.toMatch(/^machines:/m);
  });
  it("without machines in config nothing can be set", () => {
    cfg({});
    expect(vlad(["project", "set", "alpha", "machines", "mac"]).err).toContain("config'te tanımlı değil: mac");
  });
});

describe("machines:A task ready placements", () => {
  beforeEach(() => { writeCard(home, "alpha"); writeCard(home, "winonly"); });
  const nt = (project: string) => {
    const r = run(home, ["task", "new", "--project", project, "--title", "T", "--kind", "dev", "--body-file", "-", "--json"], { input: "## Tanım\nx\n", env: NO_CLOUD_ENV });
    expect(r.code, r.err).toBe(0);
    return JSON.parse(r.out).id as string;
  };

  it("K4 shape: with no machines in config the JSON has no placement keys and the text has no @tag", () => {
    nt("alpha");
    const r = json(["task", "ready"]);
    expect(Object.keys(r).sort()).toEqual(["held_by_limit", "maxParallel", "running", "tasks"]);
    expect(vlad(["task", "ready"]).out).not.toContain("@");
  });
  it("K1: mac busy -> [mac,windows] project placed on windows; K2: [windows] project never lands on mac", () => {
    cfg(MACHINES);
    vlad(["project", "set", "alpha", "machines", "mac,windows"]);
    vlad(["project", "set", "winonly", "machines", "windows"]);
    const busy = nt("alpha");
    expect(vlad(["task", "set", busy, "running"]).code).toBe(0);
    const a = nt("alpha"), w = nt("winonly");
    const r = json(["task", "ready"]);
    expect(r.placements).toEqual([{ id: a, machine: "windows" }]);
    expect(r.held_by_limit.map((t: any) => t.id)).toEqual([w]);
    expect(r.held_reasons).toEqual([{ id: w, reasons: [{ machine: "windows", reason: "dolu" }] }]);
    expect(r.tasks.map((t: any) => t.id)).toEqual([a]);
    expect(vlad(["task", "ready"]).out).toMatch(/\(.*dolu/);
  });
  it("a card without machines places on the brain and respects the machine cap", () => {
    cfg(MACHINES);
    const a = nt("alpha"), b = nt("alpha");
    const r = json(["task", "ready"]);
    expect(r.placements).toEqual([{ id: a, machine: "mac" }]);
    expect(r.held_by_limit.map((t: any) => t.id)).toEqual([b]);
  });
  it("a running task recorded on windows consumes the windows slot", () => {
    cfg(MACHINES);
    vlad(["project", "set", "winonly", "machines", "windows"]);
    const run1 = nt("winonly");
    vlad(["task", "set", run1, "running"]);
    setTask(run1, { machine: "windows" });
    const w = nt("winonly");
    expect(json(["task", "ready"]).held_by_limit.map((t: any) => t.id)).toEqual([w]);
  });
});

describe("machines:A task list machine field and @tag", () => {
  beforeEach(() => { writeCard(home, "alpha"); cfg(MACHINES); });
  it("--fields machine returns it; plain lines get @<machine> only for a non-brain machine", () => {
    const x = newTask(home), y = newTask(home);
    setTask(x, { machine: "windows" });
    setTask(y, { machine: "mac" });
    const rows = json(["task", "list", "--fields", "id,machine"]).tasks;
    expect(rows.find((t: any) => t.id === x).machine).toBe("windows");
    const out = vlad(["task", "list"]).out.split("\n");
    expect(out.find((l) => l.startsWith(x))).toMatch(/@windows$/);
    expect(out.find((l) => l.startsWith(y))).not.toContain("@");
  });
  it("tasks without a machine are unchanged", () => {
    const z = newTask(home);
    expect(vlad(["task", "list"]).out.split("\n").find((l) => l.startsWith(z))).not.toContain("@");
    expect(json(["task", "list", "--fields", "id,machine"]).tasks[0]).not.toHaveProperty("machine");
  });
});
