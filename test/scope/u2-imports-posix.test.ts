import { describe, expect, it } from "vitest";
import { toPosix, unitOf } from "../arch/imports.js";

// Codex 61a P2: on Windows path.relative yields backslashes; unitOf/layers lookups expect "/" (cannot run on win32 here, so the helper is tested directly)
describe("u2 arch imports: path separators", () => {
  it("toPosix turns Windows separators into slashes", () => {
    expect(toPosix("kb\\lint\\index.ts")).toBe("kb/lint/index.ts");
    expect(toPosix("kb/lint.ts")).toBe("kb/lint.ts");
  });
  it("unitOf resolves the first directory of a Windows-style path", () => {
    expect(unitOf(toPosix("tasks\\launch.ts"))).toBe("tasks");
  });
});
