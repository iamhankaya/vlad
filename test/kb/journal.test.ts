import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendJournal } from "../../src/kb/journal.js";
import { addDecision } from "../../src/kb/decisions.js";
import { makeHome } from "../helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });

describe("addDecision", () => {
  it("appends blocks in order in the spec format", () => {
    const now = new Date(2026, 9, 15, 12, 0, 0);
    addDecision({ project: "watchparty", title: "Bir", body: "- **Karar:** x\n- **Gerekçe:** y", source: "görev T1" }, now);
    addDecision({ project: "watchparty", title: "İki", body: "- **Karar:** z" }, now);
    const text = readFileSync(join(home, "kb", "decisions", "watchparty.md"), "utf8");
    const heads = text.split("\n").filter((l) => l.startsWith("### "));
    expect(heads).toEqual(["### 2026-10-15 — watchparty — Bir", "### 2026-10-15 — watchparty — İki"]);
    expect(text).toContain("- **Kaynak:** görev T1");
    expect(text.indexOf("Bir")).toBeLessThan(text.indexOf("İki"));
  });
});

describe("appendJournal", () => {
  it("creates a missing day with a heading and appends", () => {
    appendJournal("2026-10-15", "## watchparty\n- a");
    appendJournal("2026-10-15", "- b");
    const text = readFileSync(join(home, "kb", "journal", "2026-10-15.md"), "utf8");
    expect(text.startsWith("# 2026-10-15\n")).toBe(true);
    expect(text.match(/^# 2026-10-15$/gm)).toHaveLength(1);
    expect(text.indexOf("- a")).toBeLessThan(text.indexOf("- b"));
  });
  it("merges a repeated `## <project>` heading of the same day into the existing section", () => {
    appendJournal("2026-10-15", "## watchparty\n- a");
    appendJournal("2026-10-15", "## diğer\n- x");
    appendJournal("2026-10-15", "## watchparty\n- b\n- c");
    const text = readFileSync(join(home, "kb", "journal", "2026-10-15.md"), "utf8");
    expect(text.match(/^## watchparty$/gm)).toHaveLength(1);
    expect(text.match(/^## diğer$/gm)).toHaveLength(1);
    // new items sit at the end of the watchparty section, before the next heading
    expect(text.indexOf("- a")).toBeLessThan(text.indexOf("- b"));
    expect(text.indexOf("- c")).toBeLessThan(text.indexOf("## diğer"));
    expect(text.indexOf("- x")).toBeGreaterThan(text.indexOf("- c"));
  });
  it("when the day already has the same heading twice (older files), merges into the LAST one", () => {
    appendJournal("2026-10-15", "## watchparty\n- a\n\n## diğer\n- x\n\n## watchparty\n- b");
    appendJournal("2026-10-15", "## watchparty\n- c");
    const text = readFileSync(join(home, "kb", "journal", "2026-10-15.md"), "utf8");
    expect(text.match(/^## watchparty$/gm)).toHaveLength(2);
    expect(text.indexOf("- c")).toBeGreaterThan(text.indexOf("- b"));
    expect(text.indexOf("- c")).toBeGreaterThan(text.lastIndexOf("## watchparty"));
  });
  it("merges several sections of one append (existing ones merged, new ones appended)", () => {
    appendJournal("2026-10-15", "## a\n- 1\n\n## b\n- 2");
    appendJournal("2026-10-15", "## b\n- 3\n\n## c\n- 4");
    const text = readFileSync(join(home, "kb", "journal", "2026-10-15.md"), "utf8");
    expect(text.match(/^## b$/gm)).toHaveLength(1);
    expect(text.match(/^## c$/gm)).toHaveLength(1);
    expect(text.indexOf("- 3")).toBeLessThan(text.indexOf("## c"));
    expect(text.indexOf("- 2")).toBeLessThan(text.indexOf("- 3"));
  });
  it("rejects a malformed date", () => {
    expect(() => appendJournal("../x", "a")).toThrow();
  });
});
