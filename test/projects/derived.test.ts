import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addFinding, setFindingState } from "../../src/findings/store.js";
import { addDecision } from "../../src/kb/decisions.js";
import { DERIVED_CLOSE, derivedOpen, replaceDerivedBlock } from "../../src/kb/derived.js";
import { refreshAllProjects, refreshProject } from "../../src/projects/derived.js";
import { projectStatus } from "../../src/projects/status.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, setState } from "../../src/tasks/store.js";
import { makeHome } from "../helpers.js";

const card = (slug: string, tail = "## Özet\nx\n\n## Açık konular\n- elle yazılmış: kullanıcı kararı bekliyor\n\n## Son aktivite\n- eski elle satır\n\n## Çalışma notları\n- 2026-10-01: ders\n") =>
  `---\nslug: ${slug}\nname: ${slug}\npath: C:\dev\${slug}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n${tail}`;
let home: string;
const cardFile = () => join(home, "kb", "projects", "vlad.md");
const read = () => readFileSync(cardFile(), "utf8");
const done = (title: string, at: Date) => {
  const t = createTask({ project: "vlad", title, kind: "dev", body: "" }, at);
  setState(t.data.id, "running"); setState(t.data.id, "awaiting_approval"); setState(t.data.id, "done");
  return t.data.id;
};
beforeEach(() => { home = makeHome(); writeProject("vlad", card("vlad")); });

describe("replaceDerivedBlock", () => {
  const open = derivedOpen("x");
  it("keeps all text outside an existing block byte for byte, CRLF included", () => {
    const text = `## A\r\nön\r\n${open}\r\neski\r\n${DERIVED_CLOSE}\r\nson\r\n\r\n## B\r\nb\r\n`;
    const r = replaceDerivedBlock(text, "x", "yeni", "## A");
    expect(r).toBe(`## A\r\nön\r\n${open}\r\nyeni\r\n${DERIVED_CLOSE}\r\nson\r\n\r\n## B\r\nb\r\n`);
  });
  it("appends a missing block to the end of its section, creates a missing section", () => {
    const r = replaceDerivedBlock("## A\nön\n\n## B\nb\n", "x", "yeni", "## A");
    expect(r).toBe(`## A\nön\n\n${open}\nyeni\n${DERIVED_CLOSE}\n\n## B\nb\n`);
    const c = replaceDerivedBlock("## B\nb\n", "x", "yeni", "## A");
    expect(c).toBe(`## B\nb\n\n## A\n${open}\nyeni\n${DERIVED_CLOSE}\n`);
  });
  it("is idempotent", () => {
    const once = replaceDerivedBlock("## A\nön\n", "x", "yeni", "## A");
    expect(replaceDerivedBlock(once, "x", "yeni", "## A")).toBe(once);
  });
});

describe("refreshProject", () => {
  it("adds the open-findings block, keeps hand-written Açık konular text, orders by severity", () => {
    addFinding({ project: "vlad", severity: "orta", source: "T20261101-01", title: "Orta bulgu" });
    addFinding({ project: "vlad", severity: "kritik", source: "T20261101-01", title: "Kritik bulgu" });
    addFinding({ project: "vlad", severity: "düşük", source: "T20261101-01", title: "Düşük", state: "deferred" });
    refreshProject("vlad");
    const raw = read();
    expect(raw).toContain("- elle yazılmış: kullanıcı kararı bekliyor");
    const block = raw.slice(raw.indexOf(derivedOpen("open-findings")), raw.indexOf(DERIVED_CLOSE));
    expect(block.indexOf("Kritik bulgu")).toBeLessThan(block.indexOf("Orta bulgu"));
    expect(block.indexOf("Orta bulgu")).toBeLessThan(block.indexOf("Düşük"));
    expect(block).toContain("F-vlad-002");
  });
  it("a fixed finding drops out of the block", () => {
    const f = addFinding({ project: "vlad", severity: "yüksek", source: "T20261101-01", title: "Düzelecek" });
    refreshProject("vlad");
    expect(read()).toContain("Düzelecek");
    setFindingState(f.data.id, "fixed", "T20261101-02");
    refreshProject("vlad");
    expect(read()).not.toContain("Düzelecek");
    expect(read()).toContain("- elle yazılmış");
  });
  it("Son aktivite is fully derived: done tasks and decisions, newest first, max 10, hand lines removed", () => {
    const base = Date.now();
    for (let i = 0; i < 11; i++) done(`İş ${i}`, new Date(base + i * 1000));
    addDecision({ project: "vlad", title: "Bir karar", body: "- **Karar:** k" });
    refreshProject("vlad");
    const raw = read();
    expect(raw).not.toContain("eski elle satır");
    const sec = raw.slice(raw.indexOf("## Son aktivite"), raw.indexOf("## Çalışma notları"));
    expect(sec.match(/^- /gm)).toHaveLength(10);
    expect(sec).toContain("D-vlad-001");
    expect(sec).toContain("Bir karar");
    expect(sec).not.toContain("İş 0");
  });
  it("a task that becomes done enters Son aktivite", () => {
    refreshProject("vlad");
    const id = done("Biten iş", new Date());
    refreshProject("vlad");
    expect(read()).toMatch(new RegExp(`- [0-9-]{10} ${id} Biten iş`));
  });
  it("leaves everything outside the blocks untouched and does not rewrite an up-to-date card", () => {
    addFinding({ project: "vlad", severity: "yüksek", source: "T20261101-01", title: "B" });
    refreshProject("vlad");
    const first = read();
    expect(first).toContain("## Çalışma notları\n- 2026-10-01: ders\n");
    expect(first.startsWith("---\nslug: vlad")).toBe(true);
    expect(refreshProject("vlad")).toBe(false);
    expect(read()).toBe(first);
  });
  it("works on a CRLF card and keeps projectStatus intact", () => {
    writeFileSync(cardFile(), read().replace(/\n/g, "\r\n"));
    addFinding({ project: "vlad", severity: "yüksek", source: "T20261101-01", title: "CRLF bulgu" });
    refreshProject("vlad");
    const raw = read();
    expect(raw).toContain("CRLF bulgu");
    expect(raw).toContain("- elle yazılmış: kullanıcı kararı bekliyor");
    expect(projectStatus("vlad").findings.open.map((f) => f.title)).toEqual(["CRLF bulgu"]);
  });
  it("refreshAllProjects refreshes every card and reports unreadable ones", () => {
    writeProject("beta", card("beta"));
    writeFileSync(join(home, "kb", "projects", "bozuk.md"), "bozuk");
    addFinding({ project: "vlad", severity: "yüksek", source: "T20261101-01", title: "V" });
    const r = refreshAllProjects();
    expect(r.refreshed.sort()).toEqual(["beta", "vlad"]);
    expect(r.warnings.join()).toContain("bozuk.md");
  });
});
