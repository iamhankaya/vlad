import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const mdIn = (dir: string): string[] => readdirSync(join(root, dir)).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));

describe("docs follow the per-project decisions layout", () => {
  it("no VLAD-owned doc still points at the single kb/decisions.md", () => {
    const files = [
      "CLAUDE.md", "README.md", ...mdIn("roles"),
      ...["delegate", "digest", "status", "integrate", "scan", "second-opinion", "art-prompt"].map((s) => `.claude/skills/${s}/SKILL.md`),
      ...["vlad-worker", "ci-triage"].map((s) => `global/skills/${s}/SKILL.md`),
    ];
    const stale = files.filter((f) => /kb\/decisions\.md/.test(readFileSync(join(root, f), "utf8")));
    expect(stale).toEqual([]);
  });
});
