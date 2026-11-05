import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  it("loads the committed vlad.config.json", () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const cfg = loadConfig(repo);
    // roots/brain/machines are per-machine (Mac brain + Windows worker, D-vlad-055); only the machine-independent fields are pinned.
    expect(cfg).toMatchObject({
      ignore: ["*-wt", "node_modules", "vlad"], defaultAutonomy: "commit",
      staleAfterHours: 6, launcher: "auto", kbDir: "../vlad-kb", workerAutoCompact: "300k", worktreeDir: "{repo}-wt",
      projects: { watchparty: { autonomy: "commit" }, "ashen-bastion": { autonomy: "pr" } },
    });
    expect(cfg.roots.length).toBeGreaterThan(0);
  });
  it("uses schemas of the given home, not VLAD_HOME", () => {
    process.env.VLAD_HOME = mkdtempSync(join(tmpdir(), "vlad-empty-"));
    expect(loadConfig(home).launcher).toBe("auto");
  });
  it("malformed JSON error mentions the path", () => {
    writeFileSync(join(home, "vlad.config.json"), "{bad");
    expect(() => loadConfig(home)).toThrow(join(home, "vlad.config.json"));
  });
  it("maxParallel is optional and must be a positive integer", () => {
    expect(loadConfig(home).maxParallel).toBeUndefined();
    writeFileSync(join(home, "vlad.config.json"), '{"maxParallel": 2}');
    expect(loadConfig(home).maxParallel).toBe(2);
    for (const bad of ["0", "1.5", '"x"']) {
      writeFileSync(join(home, "vlad.config.json"), `{"maxParallel": ${bad}}`);
      expect(() => loadConfig(home)).toThrow();
    }
  });
  it("workerAutoCompact is optional; accepts k/M suffix within 100000–1000000, else a schema error", () => {
    expect(loadConfig(home).workerAutoCompact).toBeUndefined();
    for (const ok of ["300k", "300000", "100k", "1M", "1000k", "1000000", "0.5M"]) {
      writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ workerAutoCompact: ok }));
      expect(loadConfig(home).workerAutoCompact, ok).toBe(ok);
    }
    for (const bad of ["99k", "99999", "1001k", "2M", "abc", "300 k", "-300k", "300kb", "$(x)"]) {
      writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ workerAutoCompact: bad }));
      expect(() => loadConfig(home), bad).toThrow();
    }
    writeFileSync(join(home, "vlad.config.json"), '{"workerAutoCompact": 300000}');
    expect(() => loadConfig(home)).toThrow();
  });
  it("empty workerAutoCompact means no flag and is accepted", () => {
    writeFileSync(join(home, "vlad.config.json"), '{"workerAutoCompact": ""}');
    expect(loadConfig(home).workerAutoCompact).toBe("");
  });
  it("rejects invalid launcher", () => {
    writeFileSync(join(home, "vlad.config.json"), '{"launcher":"x"}');
    expect(() => loadConfig(home)).toThrow(ValidationError);
  });
});
