import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnGuarded } from "../support/spawn-vlad.js";
import { rmTemp } from "../helpers.js";
import { trustKey } from "../../src/tasks/trust.js";

const DIST = join(import.meta.dirname, "..", "..", "dist");

// F-vlad-266: the preflight `node -e import(<file url>)` only resolves from the built dist (src/*.ts is not loadable by plain node);
// the unit tests import the src module, so only the dist copy proves the URL points at a real trust.js.
describe("launch script trust preflight (dist)", () => {
  it("the preflight line of a dist-built script resolves to dist/tasks/trust.js and writes the trust record", async () => {
    expect(existsSync(join(DIST, "tasks", "trust.js"))).toBe(true);
    const { buildPosixScript } = (await import(join(DIST, "launcher", "posix.js"))) as typeof import("../../src/launcher/posix.js");
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "vlad-trust-pre-")));
    try {
      const cwd = join(tmp, "wt");
      const script = buildPosixScript({ cwd, title: "t", prompt: "p", env: {} } as never);
      const line = script.split("\n").find((l) => l.includes("-e") && l.includes("trust.js"));
      expect(line).toBeDefined();
      expect(line).toContain(join("dist", "tasks", "trust.js").replaceAll("\\", "/"));
      const claudeJson = join(tmp, "claude.json");
      const r = spawnGuarded("bash", ["-c", line as string], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: tmp, VLAD_CLAUDE_JSON: claudeJson } });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      const j = JSON.parse(readFileSync(claudeJson, "utf8")) as { projects: Record<string, unknown> };
      expect(Object.keys(j.projects)).toContain(trustKey(cwd)); // ürün anahtarı bilerek `/` ile yazar (Windows'ta `\` değil)
    } finally { rmTemp(tmp); }
  });
});
