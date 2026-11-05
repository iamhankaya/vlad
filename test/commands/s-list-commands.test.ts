import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/commands/manifest.js";
import { validateManifest } from "../../src/commands/types.js";

const root = resolve(import.meta.dirname, "../..");
function listCommands(): { version: number; commands: { path: string[]; hasJson: boolean }[] } {
  const r = spawnSync(process.execPath, ["scripts/list-commands.mjs"], { cwd: root, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: { PATH: process.env.PATH ?? "" } });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

describe("s-list-commands", () => {
  const inv = listCommands();
  it("walks the real tree: leaves only, unique paths, known commands present", () => {
    const names = inv.commands.map((c) => c.path.join(" "));
    expect(new Set(names).size).toBe(names.length);
    for (const k of ["scan", "task log", "digest pending add", "remote", "clip set", "status"]) expect(names).toContain(k);
    expect(names).not.toContain("task"); // group nodes are not leaves
    expect(inv.commands.length).toBeGreaterThan(60);
  });
  it("`remote` is the plain-registered leaf without --json", () => {
    expect(inv.commands.find((c) => c.path.join(" ") === "remote")?.hasJson).toBe(false);
    expect(inv.commands.find((c) => c.path.join(" ") === "task log")?.hasJson).toBe(true);
  });
  it("completeness check is wired: an empty manifest misses every leaf", () => {
    const errs = validateManifest([], inv.commands.map((c) => c.path));
    expect(errs).toHaveLength(inv.commands.length);
    expect(errs[0]).toMatch(/^manifestte yok: /);
  });
  it("manifest `json` flag = the real --json option of each leaf", () => {
    for (const c of inv.commands) expect(COMMANDS.find((s) => s.path.join(" ") === c.path.join(" "))?.json, c.path.join(" ")).toBe(c.hasJson);
  });
  it("manifest ↔ Commander tree is complete both ways", () => {
    expect(validateManifest(COMMANDS, inv.commands.map((c) => c.path))).toEqual([]);
  });
});
