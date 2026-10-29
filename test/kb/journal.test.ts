import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addDecision, appendJournal } from "../../src/kb/journal.js";
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
  it("rejects a malformed date", () => {
    expect(() => appendJournal("../x", "a")).toThrow();
  });
});
