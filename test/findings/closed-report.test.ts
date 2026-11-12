import { beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths } from "../../src/kb/index.js";
import { addFinding, setFindingState } from "../../src/findings/store.js";
import { closedFindingWarnings } from "../../src/findings/closed-report.js";
import { makeHome } from "../helpers.js";

const add = (title: string) => {
  writeFileSync(join(kbPaths().projects, "alpha.md"), "---\nslug: x\n---\n");
  return addFinding({ project: "alpha", severity: "orta", source: "T20261022-01", title });
};
const rep = (lines: string) => `### Yapılanlar\nx\n### Kapatılan bulgular\n${lines}\n### Açık noktalar\n- F-alpha-009 bu bölümde sayılmaz\n`;

describe("closedFindingWarnings", () => {
  beforeEach(() => { makeHome(); });
  it("no section → no warnings (old behaviour)", () => {
    expect(closedFindingWarnings("### Yapılanlar\nF-alpha-099 düzeldi")).toEqual([]);
  });
  it("open known id → no warning; unknown and already closed ids warn; other sections ignored", () => {
    const a = add("a"), b = add("b");
    setFindingState(b.data.id, "fixed");
    const w = closedFindingWarnings(rep(`- ${a.data.id} — fixed — abc123\n- ${b.data.id} — fixed — abc124\n- F-alpha-077 — fixed — x.ts:1`));
    expect(w).toHaveLength(2);
    expect(w.join("\n")).toMatch(/F-alpha-002.*kapalı/);
    expect(w.join("\n")).toMatch(/F-alpha-077.*bilinmiyor/);
  });
  it("abbreviated / range ids warn", () => {
    const w = closedFindingWarnings(rep("- F-alpha-014,017-024 — fixed — abc\n- F-024 — fixed — abc"));
    expect(w.some((x) => x.includes("F-alpha-014,017-024"))).toBe(true);
    expect(w.some((x) => x.includes("F-024"))).toBe(true);
    expect(w.every((x) => /kısaltılmış/.test(x))).toBe(true);
  });
});

describe("F-vlad-309: kısmi satır kapatılmaz", () => {
  beforeEach(() => { makeHome(); });
  it("closedFindingTokens skips 'kısmen'/'açık kalır' lines; closedFindingWarnings flags them", async () => {
    const { closedFindingTokens } = await import("../../src/findings/closed-report.js");
    const a = add("a"), b = add("b");
    const md = rep(`- ${a.data.id} — fixed — abc123\n- ${b.data.id} — kısmen: yarısı; bulgu açık kalır`);
    expect(closedFindingTokens(md)).toEqual([a.data.id]);
    expect(closedFindingWarnings(md).join("\n")).toMatch(new RegExp(`${b.data.id}.*kısmi`));
  });
});
