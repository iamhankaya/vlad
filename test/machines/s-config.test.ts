import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, validate } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });
const write = (o: object) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify(o));
const machine = (name: string, extra: object = {}) => ({ name, os: "win32", agent: { host: "192.168.1.20", port: 7437 }, ...extra });
const ok = { brain: "mac", machines: [machine("mac", { os: "darwin", agent: { host: "192.168.1.10", port: 7437 } }), machine("windows")], consoles: [{ name: "desktop" }] };

describe("machines:S config", () => {
  it("valid machines config loads", () => {
    write(ok);
    const c = loadConfig(home);
    expect(c.brain).toBe("mac");
    expect(c.machines?.map((m) => m.name)).toEqual(["mac", "windows"]);
    expect(c.consoles).toEqual([{ name: "desktop" }]);
  });
  it("without machines the loaded config is byte-for-byte the old shape", () => {
    write({ staleAfterHours: 2 });
    const c = loadConfig(home);
    expect("machines" in c || "brain" in c || "consoles" in c).toBe(false);
  });
  it("machines without brain is rejected", () => {
    write({ machines: ok.machines });
    expect(() => loadConfig(home)).toThrow(/^config: .*brain/);
  });
  it("brain must be one of the machines", () => {
    write({ ...ok, brain: "ghost" });
    expect(() => loadConfig(home)).toThrow(/^config: .*brain.*ghost/);
  });
  it("duplicate machine names are rejected", () => {
    write({ ...ok, machines: [...ok.machines, machine("windows")] });
    expect(() => loadConfig(home)).toThrow(/^config: .*birden fazla.*windows/);
  });
  it("a console name cannot equal a machine name", () => {
    write({ ...ok, consoles: [{ name: "windows" }] });
    expect(() => loadConfig(home)).toThrow(/^config: .*konsol.*windows/);
  });
  it("'self' is a reserved identity name", () => {
    write({ ...ok, consoles: [{ name: "self" }] });
    expect(() => loadConfig(home)).toThrow(/^config: .*self/);
  });
  it("non-brain machines need agent.host", () => {
    const w = { name: "windows", os: "win32", agent: { port: 7437 } };
    write({ ...ok, machines: [ok.machines[0], w] });
    expect(() => loadConfig(home)).toThrow(/^config: windows.*agent.host/);
  });
  it.each(["-evil", "a b", "x;y", "", "a/b"])("agent.host %j is rejected", (host) => {
    write({ ...ok, machines: [ok.machines[0], machine("windows", { agent: { host, port: 7437 } })] });
    expect(() => loadConfig(home)).toThrow();
  });
  it.each([80, 1023, 65536, 7437.5])("agent.port %j is rejected", (port) => {
    write({ ...ok, machines: [ok.machines[0], machine("windows", { agent: { host: "10.0.0.2", port } })] });
    expect(() => loadConfig(home)).toThrow();
  });
  it.each(["Win", "1win", "w_x"])("machine name %j is rejected", (name) => {
    write({ brain: name, machines: [machine(name)] });
    expect(() => loadConfig(home)).toThrow();
  });
  it("unknown os / unknown machine field is rejected", () => {
    write({ ...ok, machines: [ok.machines[0], machine("windows", { os: "beos" })] });
    expect(() => loadConfig(home)).toThrow();
    write({ ...ok, machines: [ok.machines[0], machine("windows", { extra: 1 })] });
    expect(() => loadConfig(home)).toThrow();
  });
});

describe("machines:S schemas", () => {
  const card = { slug: "x", name: "x", path: "/dev/x", stack: [], status: "active", autonomy: "commit", last_activity: null, last_scanned: null };
  const task = { id: "T20261101-01", project: "x", title: "t", kind: "dev", state: "queued", autonomy: "commit", created: "2026-11-01T10:00:00+03:00", updated: "2026-11-01T10:00:00+03:00" };
  it("project card accepts machines (non-empty, unique)", () => {
    expect(() => validate("project", { ...card, machines: ["mac", "windows"] }, home)).not.toThrow();
    expect(() => validate("project", { ...card, machines: [] }, home)).toThrow();
    expect(() => validate("project", { ...card, machines: ["mac", "mac"] }, home)).toThrow();
  });
  it("task accepts machine, machine_reserved, launch_op (nullable)", () => {
    const t = { ...task, machine: "windows", machine_reserved: "2026-11-01T10:00:00+03:00", launch_op: "0b0f0d0e-0000-4000-8000-000000000000" };
    expect(() => validate("task", t, home)).not.toThrow();
    expect(() => validate("task", { ...task, machine: null, machine_reserved: null, launch_op: null }, home)).not.toThrow();
    expect(() => validate("task", { ...task, machine: 3 }, home)).toThrow();
  });
  it("the committed schema files list the new fields", () => {
    expect(readFileSync("schemas/config.schema.json", "utf8")).toContain('"machines"');
  });
});
