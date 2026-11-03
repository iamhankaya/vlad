import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addFinding, setFindingState } from "../../src/findings/store.js";
import { addDecision } from "../../src/kb/decisions.js";
import { DERIVED_CLOSE, derivedOpen, hasDerivedBlock, replaceDerivedBlock } from "../../src/kb/derived.js";
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

describe("derived block lookup ignores code fences (F-vlad-184)", () => {
  const open = derivedOpen("x");
  it("a marker example inside a fence is not the block; the real block below is replaced", () => {
    const text = `## A
\`\`\`
${open}
ornek
${DERIVED_CLOSE}
\`\`\`
${open}
eski
${DERIVED_CLOSE}
`;
    expect(replaceDerivedBlock(text, "x", "yeni", "## A")).toBe(`## A
\`\`\`
${open}
ornek
${DERIVED_CLOSE}
\`\`\`
${open}
yeni
${DERIVED_CLOSE}
`);
  });
  it("only a fenced example: a real block is appended, the example stays", () => {
    const text = `## A
\`\`\`
${open}
ornek
${DERIVED_CLOSE}
\`\`\`
`;
    const r = replaceDerivedBlock(text, "x", "yeni", "## A");
    expect(r).toBe(`${text}
${open}
yeni
${DERIVED_CLOSE}
`);
    expect(hasDerivedBlock(text, "x")).toBe(false);
    expect(hasDerivedBlock(r, "x")).toBe(true);
  });
});

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
  it("refuses an unclosed block instead of taking a later block's close", () => {
    const text = `## A
${open}
eski

## B
${derivedOpen("y")}
z
${DERIVED_CLOSE}
`;
    expect(() => replaceDerivedBlock(text, "x", "yeni", "## A")).toThrow(/kapanmamış/);
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
  it("Son aktivite block: done tasks and decisions, newest first, max 10; hand lines stay below the block", () => {
    const base = Date.now();
    for (let i = 0; i < 11; i++) done(`İş ${i}`, new Date(base + i * 1000));
    addDecision({ project: "vlad", title: "Bir karar", body: "- **Karar:** k" });
    refreshProject("vlad");
    const raw = read();
    expect(raw).toContain("- eski elle satır");
    const blk = raw.slice(raw.indexOf(derivedOpen("recent-activity")), raw.indexOf(DERIVED_CLOSE, raw.indexOf(derivedOpen("recent-activity"))));
    expect(raw.indexOf("- eski elle satır")).toBeGreaterThan(raw.indexOf(blk) + blk.length); // block on top, hand line below
    const sec = blk;
    expect(sec.match(/^- /gm)).toHaveLength(10);
    expect(sec).toContain("D-vlad-001");
    expect(sec).toContain("Bir karar");
    expect(sec).not.toContain("İş 0");
  });
  it("fast path after decision add equals a full refresh", () => {
    const base = Date.now();
    for (let i = 0; i < 12; i++) done(`İş ${i}`, new Date(base + i * 1000));
    addDecision({ project: "vlad", title: "Bir", body: "- **Karar:** k" });
    refreshProject("vlad");
    addDecision({ project: "vlad", title: "İki", body: "- **Karar:** k" });
    refreshProject("vlad", { create: false, only: "activity", fast: true });
    const fast = read();
    expect(fast).toContain("D-vlad-002 İki");
    refreshProject("vlad"); // full scan
    expect(read()).toBe(fast);
  });
  it("fast path does not scan the tasks (a task deleted from disk stays in the block)", () => {
    const base = Date.now();
    const ids = Array.from({ length: 3 }, (_, i) => done(`İş ${i}`, new Date(base + i * 1000)));
    refreshProject("vlad");
    unlinkSync(join(home, "kb", "tasks", `${ids[2]}.md`));
    addDecision({ project: "vlad", title: "Yeni", body: "- **Karar:** k" });
    refreshProject("vlad", { create: false, only: "activity", fast: true });
    expect(read()).toContain(ids[2]);
    expect(read()).toContain("D-vlad-001 Yeni");
  });
  it("first refresh keeps hand-written Son aktivite lines byte for byte; hook leaves a block-less card alone; idempotent (CRLF too)", () => {
    const outside = (t: string) => t.replace(/<!-- vlad:derived [\s\S]*?<!-- \/vlad:derived -->\r?\n?/g, "").replace(/\r\n/g, "\n").replace(/\n\n+/g, "\n"); // blank lines are layout: the block brings its own gap
    for (const eol of ["\n", "\r\n"]) {
      const tail = "## Özet\nx\n\n## Açık konular\n- elle\n\n## Son aktivite\n- 2026-11-01 elle bir\n- 2026-11-02 elle iki (master abc1234)\n\n## Çalışma notları\n- ders\n".replace(/\n/g, eol);
      const raw = card("vlad", tail);
      writeFileSync(cardFile(), raw);
      done("Biten", new Date());
      expect(refreshProject("vlad", { create: false, only: "activity" })).toBe(false); // hook: no block, nothing written
      expect(read()).toBe(raw);
      expect(refreshProject("vlad")).toBe(true);
      const first = read();
      expect(first).toContain("- 2026-11-01 elle bir" + eol + "- 2026-11-02 elle iki (master abc1234)" + eol);
      expect(first).toContain(derivedOpen("recent-activity"));
      expect(outside(first)).toBe(outside(raw));
      if (eol === "\r\n") expect(first.slice(first.indexOf("## Özet")).replace(/\r\n/g, "")).not.toContain("\n"); // body is pure CRLF (the helper's frontmatter is LF)
      expect(refreshProject("vlad")).toBe(false);
      expect(read()).toBe(first);
    }
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
  it("a CRLF card keeps its frontmatter, EOLs and outside text byte for byte; projectStatus stays intact", () => {
    const crlf = read().replace(/\n/g, "\r\n").replace("stack: [ts]", "stack: [ts]  # yorum");
    writeFileSync(cardFile(), crlf);
    addFinding({ project: "vlad", severity: "yüksek", source: "T20261101-01", title: "CRLF bulgu" });
    refreshProject("vlad");
    const raw = read();
    expect(raw.startsWith(crlf.slice(0, crlf.indexOf("## Özet")))).toBe(true);
    expect(raw).toContain("CRLF bulgu");
    expect(raw).toContain("- elle yazılmış: kullanıcı kararı bekliyor\r\n");
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n");
    expect(projectStatus("vlad").findings.open.map((f) => f.title)).toEqual(["CRLF bulgu"]);
  });
  it("automatic refresh (create: false) leaves a card without the sections untouched; explicit refresh adds them", () => {
    const plain = card("vlad", "## Özet\nx\n");
    writeFileSync(cardFile(), plain);
    addFinding({ project: "vlad", severity: "yüksek", source: "T20261101-01", title: "B" });
    expect(refreshProject("vlad", { create: false })).toBe(false);
    expect(read()).toBe(plain);
    expect(refreshProject("vlad")).toBe(true);
    expect(read()).toContain("## Son aktivite");
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
