import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types (shared with scripts/test-scope.mjs)
import { selectScope, matchGlob, groupFilesByBucket, shouldBuild } from "../../scripts/scope-lib.mjs";

const root = join(import.meta.dirname, "..", "..");
const scope = JSON.parse(readFileSync(join(root, "test", "scope.json"), "utf8"));
const buckets = JSON.parse(readFileSync(join(root, "test", "buckets.json"), "utf8")) as Record<string, string[]>;
const sel = (...files: string[]) => selectScope(files, scope, buckets);
const BUCKETS = ["process", "agent", "platform"]; // non-unit buckets, canonical order

describe("u2 scope: glob", () => {
  it("** crosses directories, * stays in a segment", () => {
    expect(matchGlob("src/agent/ops/x.ts", "src/agent/**")).toBe(true);
    expect(matchGlob("src/agentx/y.ts", "src/agent/**")).toBe(false);
    expect(matchGlob("docs/a/b.md", "**/*.md")).toBe(true);
    expect(matchGlob("README.md", "**/*.md")).toBe(true);
    expect(matchGlob("src/a/b.ts", "src/*.ts")).toBe(false);
  });
});

describe("u2 scope: file → bucket selection", () => {
  it("a change under src/agent runs agent + process buckets and unit via --changed", () => {
    const r = sel("src/agent/forward.ts");
    expect(r.buckets).toEqual(expect.arrayContaining(["agent", "process"]));
    expect(r.unit).toBe("changed");
    expect(r.all).toBe(false);
  });
  it("src/launcher selects process + platform", () => {
    expect(sel("src/launcher/posix.ts").buckets).toEqual(["process", "platform"]);
  });
  it.each([
    "package.json", "vitest.config.ts", "test/global-setup.ts", "test/isolate-env.ts", "test/support/helper.ts",
    "test/machines/harness.ts", "test/fixtures/kb-mini/vlad.config.json", "src/cli/program.ts", "src/commands/manifest.ts",
    "src/kb/types.ts", "schemas/task.schema.json", "roles/developer.md", "global/skills/ci-triage/SKILL.md", "test/buckets.json", "test/scope.json",
  ])("shared infrastructure %s selects every bucket", (f) => {
    const r = sel(f);
    expect(r.all).toBe(true);
    expect(r.unit).toBe("all");
    expect(r.buckets).toEqual(BUCKETS);
  });
  it("an unmapped path selects every bucket and is reported", () => {
    const r = sel("tools/whatever.bin");
    expect(r.all).toBe(true);
    expect(r.unmapped).toEqual(["tools/whatever.bin"]);
  });
  it.each(["CLAUDE.md", "README.md", "docs/superpowers/spec.md", ".claude/skills/x/SKILL.md", "notes/todo.md"])(
    "document %s: the whole unit bucket runs (unit tests read these with readFileSync, so --changed cannot see them), other buckets do not", (f) => {
      const r = sel(f);
      expect(r.unit).toBe("all");
      expect(r.buckets).toEqual([]);
      expect(r.all).toBe(false);
      expect(r.warnings.join(" ")).toMatch(/yalnız docs/);
    });
  it("a path ignored by scope.json selects nothing beyond unit --changed (never zero silently)", () => {
    const r = sel("vendor/skills/x/NOTES.txt");
    expect(r.buckets).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.unit).toBe("changed");
    expect(r.ignored).toEqual(["vendor/skills/x/NOTES.txt"]);
    expect(r.all).toBe(false);
  });
  it("a changed test file runs by path instead of its whole bucket", () => {
    const r = sel("test/tasks/some.test.ts");
    expect(r.files).toEqual(["test/tasks/some.test.ts"]);
    expect(r.buckets).toEqual([]);
  });
  it("mixed change unions buckets and keeps test files", () => {
    const r = sel("src/launcher/posix.ts", "src/agent/forward.ts", "test/kb/doc.test.ts");
    expect(r.buckets).toEqual(["process", "agent", "platform"]);
    expect(r.files).toEqual(["test/kb/doc.test.ts"]);
  });
  it("no changed files at all warns instead of running zero tests", () => {
    const r = sel();
    expect(r.unit).toBe("changed");
    expect(r.warnings.join(" ")).toMatch(/değişiklik yok/);
  });
});

describe("u2 scope: scope.json stays complete", () => {
  it("every src/ top-level directory has a rule or is a shared (all) path", () => {
    const dirs = readdirSync(join(root, "src"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const d of dirs) {
      const r = sel(`src/${d}/probe.ts`);
      expect(r.unmapped, `src/${d} has no scope rule (add it to test/scope.json)`).toEqual([]);
    }
  });
  it("rule buckets and all-patterns only name real buckets", () => {
    for (const rule of scope.rules) for (const b of rule.buckets) expect(Object.keys(buckets)).toContain(b);
  });
});

describe("u2 scope: explicit test files run in their owning bucket (F-vlad-256)", () => {
  it("a unit test path is grouped under unit, a process test under process", () => {
    expect(groupFilesByBucket(["test/kb/doc.test.ts", "test/acceptance/cloud-ingest.test.ts"], buckets)).toEqual({
      unit: ["test/kb/doc.test.ts"],
      process: ["test/acceptance/cloud-ingest.test.ts"],
    });
  });
  it("a path no bucket claims is reported, never dropped", () => {
    expect(groupFilesByBucket(["test/nowhere/x.test.ts"], buckets)).toEqual({ "": ["test/nowhere/x.test.ts"] });
  });
});

describe("shouldBuild (F-vlad-319: iç içe test-run koşusu paylaşılan dist'i yeniden yazmaz)", () => {
  it("VLAD_SKIP_BUILD=1 iken tsc koşmaz (üst vitest globalSetup'ı dist'i zaten derledi/doğruladı)", () => {
    expect(shouldBuild({ VLAD_SKIP_BUILD: "1" })).toBe(false);
  });
  it("değişken yoksa ya da 1 değilse derler", () => {
    expect(shouldBuild({})).toBe(true);
    expect(shouldBuild({ VLAD_SKIP_BUILD: "0" })).toBe(true);
  });
});
