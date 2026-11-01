import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VladConfig } from "../../src/kb/index.js";
import { defaultConfig } from "../../src/kb/index.js";
import { currentMachine, isBrain, machineDef, machinesOf, readLocalSettings, resolveSelf, roleOf } from "../../src/machines/registry.js";
import { makeHome } from "../helpers.js";

let home: string;
const saved = { m: process.env.VLAD_MACHINE, l: process.env.VLAD_LOCAL_FILE };
beforeEach(() => { home = makeHome(); delete process.env.VLAD_MACHINE; delete process.env.VLAD_LOCAL_FILE; });
afterEach(() => {
  for (const [k, v] of [["VLAD_MACHINE", saved.m], ["VLAD_LOCAL_FILE", saved.l]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
const local = (o: object) => writeFileSync(join(home, "vlad.local.json"), JSON.stringify(o));
const cfgWith = (): VladConfig => ({
  ...defaultConfig(), brain: "mac", consoles: [{ name: "desktop" }],
  machines: [
    { name: "mac", os: "darwin", agent: { port: 7437 } },
    { name: "windows", os: "win32", agent: { host: "192.168.1.20", port: 7437 } },
  ],
});

describe("machines:A registry", () => {
  it("without machines everything is the brain and nothing is resolved", () => {
    const c = defaultConfig();
    expect(resolveSelf(c)).toBeNull();
    expect(currentMachine(c)).toBeNull();
    expect(isBrain(c)).toBe(true);
  });
  it("VLAD_MACHINE beats vlad.local.json self", () => {
    local({ self: "windows", keys: {} });
    process.env.VLAD_MACHINE = "mac";
    expect(resolveSelf(cfgWith())).toBe("mac");
  });
  it("falls back to vlad.local.json self; VLAD_LOCAL_FILE overrides the location", () => {
    local({ self: "windows", keys: {} });
    expect(resolveSelf(cfgWith())).toBe("windows");
    expect(isBrain(cfgWith())).toBe(false);
    writeFileSync(join(home, "other.json"), JSON.stringify({ self: "mac", keys: {} }));
    process.env.VLAD_LOCAL_FILE = join(home, "other.json");
    expect(isBrain(cfgWith())).toBe(true);
  });
  it("machines defined but self unknown -> error", () => {
    expect(() => resolveSelf(cfgWith())).toThrow(/bu makinenin kimliği belirsiz: VLAD_MACHINE ya da vlad\.local\.json self/);
  });
  it("self that is not a defined machine -> error", () => {
    process.env.VLAD_MACHINE = "ghost";
    expect(() => resolveSelf(cfgWith())).toThrow(/ghost/);
  });
  it("readLocalSettings: missing file -> empty keys; bad JSON -> error naming the file", () => {
    expect(readLocalSettings()).toEqual({ keys: {} });
    writeFileSync(join(home, "vlad.local.json"), "{nope");
    expect(() => readLocalSettings()).toThrow(/vlad\.local\.json/);
  });
  it("machineDef and roleOf", () => {
    const c = cfgWith();
    expect(machineDef(c, "windows")?.os).toBe("win32");
    expect(machineDef(c, "x")).toBeUndefined();
    expect(roleOf(c, "mac")).toBe("brain");
    expect(roleOf(c, "windows")).toBe("worker");
    expect(roleOf(c, "desktop")).toBe("console");
    expect(roleOf(c, "ghost")).toBeNull();
  });
  it("machinesOf: card order is the preference; no card list -> [brain]; undefined names split out", () => {
    const c = cfgWith();
    expect(machinesOf(c, { machines: ["windows", "mac"] })).toEqual({ names: ["windows", "mac"], unknown: [] });
    expect(machinesOf(c, {})).toEqual({ names: ["mac"], unknown: [] });
    expect(machinesOf(c, { machines: ["gone", "windows"] })).toEqual({ names: ["windows"], unknown: ["gone"] });
  });
  it("machinesOf without machines in config -> no placement (empty names)", () => {
    expect(machinesOf(defaultConfig(), { machines: ["windows"] })).toEqual({ names: [], unknown: [] });
  });
});
