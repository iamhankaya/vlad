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

describe("skills read tasks by id through `vlad kb get`", () => {
  it.each(["digest", "status", "delegate"])("%s skill does not hard-code kb/tasks/<id>.md for reading", (s) => {
    const t = readFileSync(join(root, `.claude/skills/${s}/SKILL.md`), "utf8");
    expect(t).toContain("vlad kb get");
    expect(t).not.toMatch(/kb\/tasks\/<id>\.md/);
  });
  it("the worker skill reads dependency reports through it", () => {
    const t = readFileSync(join(root, "global/skills/vlad-worker/SKILL.md"), "utf8");
    expect(t).toContain("vlad kb get <dep-id>");
    expect(t).not.toMatch(/kb\/tasks\/<dep-id>\.md`\s+dosyasındaki/);
  });
});
