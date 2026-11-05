import { readFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// test/buckets.json is the source of truth for which file runs in which bucket (partition is enforced by test/infra/buckets.test.ts)
const buckets = JSON.parse(readFileSync(join(import.meta.dirname, "test", "buckets.json"), "utf8")) as Record<string, string[]>;
const half = Math.max(2, Math.floor(cpus().length / 2));

// `extends: true` keeps the root env/setupFiles/globalSetup in every bucket (checked by test/infra/vitest-projects.test.ts)
// Per-bucket maxWorkers is deliberately not set: vitest then needs a distinct sequence.groupOrder per size and runs the groups one after another
// (agent at 2 workers doubled the total from ~90 s to ~214 s). Revisit in the verification phase if agent tests prove port-contention flaky.
const bucket = (name: string, testTimeout: number) => ({
  extends: true as const,
  test: { name, include: buckets[name], testTimeout },
});

export default defineConfig({
  // maxWorkers: half the cores keeps CLI-spawning tests off the 5-30 s timeout cliff under parallel load (F-vlad-018/121)
  // tests run the same in the cloud and locally; cloud behavior is switched on per test; VLAD_LAUNCHER=noop keeps tests from opening real workers (F-vlad-064); VLAD_NO_NATIVE=1 keeps real clipboard/notification/helper processes off (aktarım); VLAD_CLAUDE_JSON keeps launch/cleanup off the real ~/.claude.json
  test: {
    testTimeout: 30_000,
    maxWorkers: half,
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup-cleanup.ts"],
    env: { CLAUDE_CODE_REMOTE: "", VLAD_LAUNCHER: "noop", VLAD_NO_NATIVE: "1", VLAD_CLAUDE_JSON: join(tmpdir(), "vlad-test-claude.json") },
    projects: [bucket("unit", 5_000), bucket("process", 30_000), bucket("agent", 30_000), bucket("platform", 30_000)],
  },
});
