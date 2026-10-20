import { defineConfig } from "vitest/config";

export default defineConfig({
  // tests run the same in the cloud and locally; cloud behavior is switched on per test
  test: { include: ["test/**/*.test.ts"], env: { CLAUDE_CODE_REMOTE: "" } },
});
