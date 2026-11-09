import { describe, expect, it } from "vitest";
import { legacyKey, validateManifest } from "../../src/commands/types.js";
import type { CommandSpec } from "../../src/commands/types.js";
import { COMMANDS } from "../../src/commands/manifest.js";
import { consoleCatalog, forwardMap, kbWriteKeys, lockPolicyFor, refreshKeys, workerLocalKeys } from "../../src/commands/accessors.js";
import { KB_WRITES, REFRESH_KEYS } from "../../src/cli/program.js";

const spec = (over: Partial<CommandSpec> & { path: string[] }): CommandSpec => ({
  registration: "def", exec: "standard", lock: "none", refresh: false,
  worker: { kind: "reject" }, console: { kind: "none", reason: "test" }, json: true, ...over,
});

describe("s-types: legacyKey", () => {
  it("matches the old def() key: `<parent name> <first token>`", () => {
    expect(legacyKey(["scan"])).toBe("vlad scan");
    expect(legacyKey(["task", "log"])).toBe("task log");
    expect(legacyKey(["digest", "pending", "add"])).toBe("pending add");
  });
});

describe("s-types: validateManifest", () => {
  it("accepts a valid set", () => {
    expect(validateManifest([spec({ path: ["scan"] }), spec({ path: ["task", "log"], lock: "outer", worker: { kind: "local" } })])).toEqual([]);
  });
  it("rejects key collisions unless `key` is set by hand", () => {
    const a = spec({ path: ["digest", "pending", "add"] }), b = spec({ path: ["pending", "add"] });
    expect(validateManifest([a, b])[0]).toMatch(/pending add/);
    expect(validateManifest([a, { ...b, key: "pending add 2" }])).toEqual([]);
  });
  it("refresh requires an outer lock", () => {
    expect(validateManifest([spec({ path: ["task", "set"], refresh: true, lock: "inner" as never })])[0]).toMatch(/refresh/);
    expect(validateManifest([spec({ path: ["task", "set"], refresh: true, lock: "phased" })])[0]).toMatch(/refresh/);
    expect(validateManifest([spec({ path: ["task", "set"], refresh: true, lock: "none" })])[0]).toMatch(/refresh/);
    expect(validateManifest([spec({ path: ["task", "set"], refresh: true, lock: "outer" })])).toEqual([]);
  });
  it("console none needs a reason", () => {
    expect(validateManifest([spec({ path: ["scan"], console: { kind: "none", reason: "" } })])[0]).toMatch(/reason/);
  });
  it("a missing worker policy is an error (fail-closed)", () => {
    const s = spec({ path: ["scan"] }) as unknown as Record<string, unknown>;
    delete s.worker;
    expect(validateManifest([s as unknown as CommandSpec])[0]).toMatch(/worker/);
  });
  it("exec status is only for `vlad status`", () => {
    expect(validateManifest([spec({ path: ["mode", "status"], exec: "status" })])[0]).toMatch(/status/);
    expect(validateManifest([spec({ path: ["status"], exec: "status" })])).toEqual([]);
  });
});

describe("s-types: filled manifest and accessors (U1 replaced the S stub)", () => {
  it("COMMANDS is filled and the accessors answer from it (the S-time throw is gone)", () => {
    expect(COMMANDS.length).toBeGreaterThan(60);
    for (const f of [kbWriteKeys, refreshKeys, workerLocalKeys]) expect(f().size).toBeGreaterThan(0);
    expect(Object.keys(forwardMap())).toHaveLength(5);
    expect(Object.keys(consoleCatalog())).toHaveLength(COMMANDS.length);
    expect(lockPolicyFor("task log", () => ({}))).toBe("outer");
    expect(lockPolicyFor("vlad scan", () => ({}))).toBe("none");
  });
});

describe("s-types: KB_WRITES / REFRESH_KEYS are exported and consistent", () => {
  it("export real, non-empty sets", () => {
    expect(KB_WRITES.size).toBeGreaterThan(30);
    expect(REFRESH_KEYS.size).toBe(9);
  });
  it("every refresh key writes the kb", () => {
    for (const k of REFRESH_KEYS) expect(KB_WRITES.has(k)).toBe(true);
  });
});
