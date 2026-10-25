import { defineConfig } from "vitest/config";

export default defineConfig({
  // tests run the same in the cloud and locally; cloud behavior is switched on per test
  test: { globalSetup: ["test/global-setup.ts"], include: ["test/**/*.test.ts"], testTimeout: 30_000, env: { CLAUDE_CODE_REMOTE: "" } },
});
