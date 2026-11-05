import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";

const root = join(import.meta.dirname, "..", "..");

// Resolves the real vitest.config.ts without running tests: `extends: true` is what keeps env/setupFiles in every bucket.
async function resolved() {
  const v = await createVitest("test", { root, watch: false, run: false });
  try {
    return {
      // globalSetup is a root-level option: it runs once for the whole run, not once per bucket
      globalSetup: v.config.globalSetup,
      projects: v.projects.map((p) => ({ name: p.name, env: p.config.env, setupFiles: p.config.setupFiles, testTimeout: p.config.testTimeout })),
    };
  } finally {
    await v.close();
  }
}

describe("vitest test.projects", () => {
  it("has one project per bucket", async () => {
    expect((await resolved()).projects.map((p) => p.name).sort()).toEqual(["agent", "platform", "process", "unit"]);
  });

  it("gives every bucket the safety env (no real workers, clipboard or ~/.claude.json)", async () => {
    for (const p of (await resolved()).projects) {
      expect(p.env, p.name).toMatchObject({ CLAUDE_CODE_REMOTE: "", VLAD_LAUNCHER: "noop", VLAD_NO_NATIVE: "1" });
      expect(p.env.VLAD_CLAUDE_JSON, p.name).toMatch(/vlad-test-claude\.json$/);
    }
  });

  it("gives every bucket the cleanup setup file, and builds once via the root global setup", async () => {
    const r = await resolved();
    for (const p of r.projects) expect(p.setupFiles.some((f) => /setup-cleanup\.ts$/.test(f)), p.name).toBe(true);
    expect(r.globalSetup.filter((f) => /global-setup\.ts$/.test(f))).toHaveLength(1);
  });

  it("keeps unit tests on a short timeout and the others on 30 s", async () => {
    const by = Object.fromEntries((await resolved()).projects.map((p) => [p.name, p.testTimeout]));
    expect(by).toEqual({ unit: 5_000, process: 30_000, agent: 30_000, platform: 30_000 });
  });
});
