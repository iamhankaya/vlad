import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError, autonomyFor, loadConfig } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });

describe("config", () => {
  it("returns defaults when file missing", () => {
    expect(loadConfig(home)).toEqual({
      roots: ["C:\\dev"], ignore: ["*-wt", "node_modules", "vlad"], defaultAutonomy: "commit",
      staleAfterHours: 6, launcher: "auto", worktreeDir: "{repo}-wt", projects: {},
    });
  });
  it("overrides only given keys", () => {
    writeFileSync(join(home, "vlad.config.json"), '{"staleAfterHours": 2}');
    const cfg = loadConfig(home);
    expect(cfg.staleAfterHours).toBe(2);
    expect(cfg.launcher).toBe("auto");
  });
  it("autonomyFor", () => {
    writeFileSync(join(home, "vlad.config.json"), '{"defaultAutonomy":"plan","projects":{"watchparty":{"autonomy":"pr"}}}');
    const cfg = loadConfig(home);
    expect(autonomyFor(cfg, "watchparty")).toBe("pr");
    expect(autonomyFor(cfg, "other")).toBe("plan");
  });
  it("rejects invalid launcher", () => {
    writeFileSync(join(home, "vlad.config.json"), '{"launcher":"x"}');
    expect(() => loadConfig(home)).toThrow(ValidationError);
  });
});
