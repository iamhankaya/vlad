import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // maxWorkers: half the cores keeps CLI-spawning tests off the 5-30 s timeout cliff under parallel load (F-vlad-018/121)
  // tests run the same in the cloud and locally; cloud behavior is switched on per test; VLAD_LAUNCHER=noop keeps tests from opening real workers (F-vlad-064); VLAD_CLAUDE_JSON keeps launch/cleanup off the real ~/.claude.json
  test: { testTimeout: 30_000, maxWorkers: Math.max(2, Math.floor(cpus().length / 2)), globalSetup: ["test/global-setup.ts"], setupFiles: ["test/setup-cleanup.ts"], include: ["test/**/*.test.ts"], env: { CLAUDE_CODE_REMOTE: "", VLAD_LAUNCHER: "noop", VLAD_CLAUDE_JSON: join(tmpdir(), "vlad-test-claude.json") } },
});
