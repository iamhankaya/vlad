import { defineConfig } from "vitest/config";

export default defineConfig({
  // tests run the same in the cloud and locally; cloud behavior is switched on per test; VLAD_LAUNCHER=noop keeps tests from opening real workers (F-vlad-064)
  test: { globalSetup: ["test/global-setup.ts"], include: ["test/**/*.test.ts"], env: { CLAUDE_CODE_REMOTE: "", VLAD_LAUNCHER: "noop" } },
});
