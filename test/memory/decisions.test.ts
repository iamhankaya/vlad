import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addDecision, listDecisions, migrateDecisions, setDecisionStatus } from "../../src/kb/decisions.js";
import { makeHome } from "../helpers.js";

const NOW = new Date(2026, 9, 30, 12, 0, 0);
let home: string;
beforeEach(() => { home = makeHome(); });
const file = (slug: string) => join(home, "kb", "decisions", `${slug}.md`);
const OLD = [
  "# Karar Günlüğü — watchparty", "",
  "### 2026-10-29 — watchparty — Ses dönüştürme mimarisi", "- **Karar:** iki yerde", "- **Kaynak:** kullanıcı", "",
  "### 2026-10-29 — watchparty — Ses dönüştürme yalnız yerel", "- **Karar:** yalnız yerel", "",
].join("\n");
const legacy = (slug = "watchparty", text = OLD) => { mkdirSync(join(home, "kb", "decisions"), { recursive: true }); writeFileSync(file(slug), text); };

describe("decision ids", () => {
  it("addDecision numbers per project, geçerli by default, returns the id", () => {
    expect(addDecision({ project: "vlad", title: "A", body: "- **Karar:** a" }, NOW)).toBe("D-vlad-001");
    expect(addDecision({ project: "vlad", title: "B", body: "- **Karar:** b", source: "T1" }, NOW)).toBe("D-vlad-002");
    const text = readFileSync(file("vlad"), "utf8");
    expect(text).toContain("### 2026-10-30 — vlad — A\n- **ID:** D-vlad-001\n- **Durum:** geçerli\n- **Karar:** a");
    expect(text).toContain("- **Kaynak:** T1");
  });
  it("general project names get D-genel-NNN in _genel.md", () => {
    expect(addDecision({ project: "Genel Kural", title: "G", body: "x" }, NOW)).toBe("D-genel-001");
    expect(readFileSync(file("_genel"), "utf8")).toContain("**ID:** D-genel-001");
  });
  it("--supersedes marks the old one yerine-geçti and links both ways", () => {
    const a = addDecision({ project: "vlad", title: "A", body: "x" }, NOW);
    const b = addDecision({ project: "vlad", title: "B", body: "y", supersedes: a }, NOW);
    const all = listDecisions({ project: "vlad", all: true });
    expect(all.find((d) => d.id === a)).toMatchObject({ status: "yerine-geçti", superseded_by: b });
    expect(all.find((d) => d.id === b)).toMatchObject({ status: "geçerli", supersedes: a });
  });
  it("rejects --supersedes with an unknown id", () => {
    expect(() => addDecision({ project: "vlad", title: "B", body: "y", supersedes: "D-vlad-009" }, NOW)).toThrow(/bulunamadı/);
  });
});

describe("decision list / set", () => {
  it("list shows only geçerli decisions unless --all; short form", () => {
    legacy(); migrateDecisions();
    setDecisionStatus("D-watchparty-001", "yerine-geçti", "D-watchparty-002");
    const valid = listDecisions({ project: "watchparty" });
    expect(valid.map((d) => d.id)).toEqual(["D-watchparty-002"]);
    expect(valid[0]).toMatchObject({ title: "Ses dönüştürme yalnız yerel", date: "2026-10-29", summary: "yalnız yerel" });
    expect(listDecisions({ project: "watchparty", all: true })).toHaveLength(2);
  });
  it("set validates: status value, superseded-by required/forbidden, unknown ids", () => {
    legacy(); migrateDecisions();
    expect(() => setDecisionStatus("D-watchparty-001", "bozuk")).toThrow(/durum/);
    expect(() => setDecisionStatus("D-watchparty-001", "yerine-geçti")).toThrow(/superseded-by/);
    expect(() => setDecisionStatus("D-watchparty-001", "geçersiz", "D-watchparty-002")).toThrow(/superseded-by/);
    expect(() => setDecisionStatus("D-watchparty-009", "geçersiz")).toThrow(/bulunamadı/);
    expect(() => setDecisionStatus("D-watchparty-001", "yerine-geçti", "D-watchparty-009")).toThrow(/bulunamadı/);
  });
  it("set geçerli clears superseded_by; the other decision keeps its link", () => {
    legacy(); migrateDecisions();
    setDecisionStatus("D-watchparty-001", "yerine-geçti", "D-watchparty-002");
    setDecisionStatus("D-watchparty-001", "geçerli");
    expect(listDecisions({ project: "watchparty" }).map((d) => d.id)).toEqual(["D-watchparty-001", "D-watchparty-002"]);
    expect(readFileSync(file("watchparty"), "utf8")).not.toMatch(/Geçersiz kılan:\*\* D-watchparty-002/);
  });
});

describe("migrate", () => {
  it("gives legacy blocks ids in order, status geçerli, loses no text, is idempotent", () => {
    legacy();
    const r = migrateDecisions();
    expect(r).toEqual([{ file: "watchparty", assigned: 2 }]);
    const text = readFileSync(file("watchparty"), "utf8");
    expect(text).toContain("### 2026-10-29 — watchparty — Ses dönüştürme mimarisi\n- **ID:** D-watchparty-001\n- **Durum:** geçerli\n- **Karar:** iki yerde");
    expect(text).toContain("D-watchparty-002");
    // stripping the added lines restores the original byte for byte
    expect(text.replace(/- \*\*(ID|Durum):\*\* .*\n/g, "")).toBe(OLD);
    expect(migrateDecisions()).toEqual([]);
    expect(readFileSync(file("watchparty"), "utf8")).toBe(text);
  });
  it("continues numbering after existing ids and dry-run writes nothing", () => {
    legacy("vlad", "# Karar Günlüğü — vlad\n\n### 2026-10-01 — vlad — Eski\n- **Karar:** a\n");
    addDecision({ project: "vlad", title: "Yeni", body: "b" }, NOW);
    expect(migrateDecisions({ dryRun: true })).toEqual([{ file: "vlad", assigned: 1 }]);
    expect(readFileSync(file("vlad"), "utf8")).not.toContain("D-vlad-002");
    migrateDecisions();
    const ids = listDecisions({ project: "vlad", all: true }).map((d) => d.id).sort();
    expect(ids).toEqual(["D-vlad-001", "D-vlad-002"]);
  });
});
