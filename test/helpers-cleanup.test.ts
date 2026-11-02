import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanupMadeDirs, makeFixtureRoot, makeHome } from "./helpers.js";

// F-vlad-105: makeHome/makeFixtureRoot dirs must not pile up in %TEMP%
describe("helpers temp cleanup", () => {
  it("cleanupMadeDirs removes the dirs makeHome and makeFixtureRoot created", () => {
    const home = makeHome();
    const root = makeFixtureRoot();
    expect(existsSync(home) && existsSync(root)).toBe(true);
    cleanupMadeDirs();
    expect(existsSync(home)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });
});
