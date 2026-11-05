import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { findProcessEnvSpreads } from "../../scripts/list-process-env.mjs";

// F-vlad-186: tests must not hand the developer's shell to children/helpers; isolatedEnv() (test/isolate-env.ts) or the spawn helper's allowlist env instead.
// Each exception names the line and why; the list may only shrink.
const ALLOWED: Record<string, string> = {
  "test/cloud/mode.test.ts": "snapshot of process.env to restore it after the test, never passed to a child",
  "test/scope/u2-no-process-env.test.ts": "this test names the pattern",
};

describe("u2: no ...process.env in tests", () => {
  it("only the documented exceptions spread process.env", () => {
    const offenders = (findProcessEnvSpreads() as { file: string; line: number; text: string }[]).filter((h) => !ALLOWED[h.file]);
    expect(offenders.map((h) => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });
  it("every exception still has a hit (stale exceptions are removed)", () => {
    const files = new Set((findProcessEnvSpreads() as { file: string }[]).map((h) => h.file));
    expect(Object.keys(ALLOWED).filter((f) => !files.has(f))).toEqual([]);
  });
});
