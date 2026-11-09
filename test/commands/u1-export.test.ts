import { spawnGuarded } from "../support/spawn-vlad.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exportCatalog } from "../../src/commands/export.js";
import { COMMANDS } from "../../src/commands/manifest.js";

const root = resolve(import.meta.dirname, "../..");

describe("u1-export: desktop catalog", () => {
  const cat = exportCatalog();
  it("has a version and one entry per manifest command with its console policy", () => {
    expect(cat.version).toBe(1);
    expect(cat.commands).toHaveLength(COMMANDS.length);
    const log = cat.commands.find((c) => c.path.join(" ") === "task log")!;
    expect(log.console).toEqual({ kind: "write" });
    expect(cat.commands.find((c) => c.path.join(" ") === "task release")!.console.kind).toBe("none");
  });
  it("is plain JSON (round-trips unchanged)", () => {
    expect(JSON.parse(JSON.stringify(cat))).toEqual(cat);
  });
  it("matches the committed snapshot: existing fields are never removed, only added (additive contract)", () => {
    const snap = JSON.parse(readFileSync(resolve(root, "test/golden/desktop-catalog.json"), "utf8")) as typeof cat;
    expect(snap.version).toBe(1);
    for (const c of snap.commands) {
      const now = cat.commands.find((x) => x.path.join(" ") === c.path.join(" "));
      expect(now, c.path.join(" ")).toBeDefined();
      expect(now).toMatchObject(c);
    }
    expect(cat).toEqual(snap); // a new command updates the snapshot in the same commit
  });
  it("scripts/check-desktop-catalog.mjs passes on the built CLI and fails on a stale snapshot", () => {
    const run = (args: string[]) => spawnGuarded(process.execPath, ["scripts/check-desktop-catalog.mjs", ...args], { cwd: root, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: { PATH: process.env.PATH ?? "" } });
    const ok = run([]);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    const bad = run(["--snapshot", resolve(root, "test/commands/fixtures/legacy-classes.json")]);
    expect(bad.status).not.toBe(0);
  });
});
