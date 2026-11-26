import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addFinding } from "../../src/findings/store.js";
import { addDecision } from "../../src/kb/decisions.js";
import { projectStatus, setProjectSummary, STALE_MIN_NEWER } from "../../src/projects/status.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, markDigested, setState } from "../../src/tasks/store.js";
import { makeHome } from "../helpers.js";

const card = (slug: string) => `---\nslug: ${slug}\nname: ${slug}\npath: C:\\dev\\${slug}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`;
const T0 = new Date(2026, 9, 30, 10, 0, 0);
const T1 = new Date(2026, 9, 30, 12, 0, 0);
let home: string;
beforeEach(() => { home = makeHome(); writeProject("vlad", card("vlad")); });

describe("projectStatus", () => {
  it("without a summary section says so; counts and lists come from records", () => {
    const t = createTask({ project: "vlad", title: "İş", kind: "dev", body: "" }, T0);
    setState(t.data.id, "running");
    addFinding({ project: "vlad", severity: "yüksek", source: t.data.id, title: "Açık yüksek" });
    addDecision({ project: "vlad", title: "K", body: "- **Karar:** k" }, T0);
    const s = projectStatus("vlad");
    expect(s.summary.state).toBe("yok");
    expect(s.tasks.counts.running).toBe(1);
    expect(s.tasks.active.map((x) => x.id)).toEqual([t.data.id]);
    expect(s.findings.open.map((f) => f.severity)).toEqual(["yüksek"]);
    expect(s.findings.counts).toEqual({ yüksek: 1 });
    expect(s.decisions).toMatchObject({ total: 1, recent: [{ id: "D-vlad-001" }] });
  });
  it("invalid decisions are not listed; unknown project fails", () => {
    addDecision({ project: "vlad", title: "A", body: "x" }, T0);
    addDecision({ project: "vlad", title: "B", body: "y", supersedes: "D-vlad-001" }, T0);
    expect(projectStatus("vlad").decisions.recent.map((d) => d.id)).toEqual(["D-vlad-002"]);
    expect(() => projectStatus("yok")).toThrow(/bulunamadı/);
  });
  it("summary is güncel until enough newer records exist on an old summary, then bayat with the records named", () => {
    setProjectSummary("vlad", "Son sonuç: x\nSıradaki: y", T1);
    expect(projectStatus("vlad").summary).toMatchObject({ state: "güncel", newer: [] });
    const mkNew = (n: number) => Array.from({ length: n }, (_, i) => createTask({ project: "vlad", title: `Yeni ${i}`, kind: "dev", body: "" }, new Date(T1.getTime() + 3600_000 + i)));
    const few = mkNew(STALE_MIN_NEWER);
    const old = new Date(T1.getTime() + 30 * 3600_000);
    // threshold: more than STALE_MIN_NEWER newer records AND a summary older than 24 h; fewer stay güncel but are still listed
    expect(projectStatus("vlad", old).summary).toMatchObject({ state: "güncel" });
    expect(projectStatus("vlad", old).summary.newer).toContain(few[0].data.id);
    const extra = createTask({ project: "vlad", title: "Bir daha", kind: "dev", body: "" }, new Date(T1.getTime() + 7200_000));
    const s = projectStatus("vlad", old).summary;
    expect(s.state).toBe("bayat");
    expect(s.newer).toContain(extra.data.id);
    expect(s.text).toContain("Sıradaki: y");
    // many records but the summary is under 24 h old: still güncel
    expect(projectStatus("vlad", new Date(T1.getTime() + 8 * 3600_000)).summary.state).toBe("güncel");
  });
  it("last_activity comes from the newest task/finding record, not the card field", () => {
    expect(projectStatus("vlad").last_activity).toBeNull(); // no records: the card's (null) value
    const t = createTask({ project: "vlad", title: "İş", kind: "dev", body: "" }, T0);
    const f = addFinding({ project: "vlad", severity: "orta", source: t.data.id, title: "f" });
    const want = [t.data.updated, f.data.updated].sort().pop();
    expect(projectStatus("vlad").last_activity).toBe(want);
  });
  it("digesting a task after the summary does not make the summary bayat", () => {
    const t = createTask({ project: "vlad", title: "İş", kind: "dev", body: "" }, T0);
    setState(t.data.id, "running"); setState(t.data.id, "awaiting_approval"); setState(t.data.id, "done");
    setProjectSummary("vlad", "x", new Date());
    markDigested([t.data.id]);
    expect(projectStatus("vlad").summary.state).toBe("güncel");
  });
  it("a task done after the summary stays in newer even once digested (updated keeps the done time)", () => {
    const t = createTask({ project: "vlad", title: "İş", kind: "dev", body: "" }, T0);
    setProjectSummary("vlad", "x", new Date(Date.now() - 3600_000));
    setState(t.data.id, "running"); setState(t.data.id, "awaiting_approval"); setState(t.data.id, "done");
    const [d] = markDigested([t.data.id], new Date(Date.now() + 5000));
    expect(d.data.updated).not.toBe(d.data.digested);
    expect(projectStatus("vlad").summary.newer).toContain(t.data.id);
  });
  it("a task digested after the summary that covered it is not newer", () => {
    const t = createTask({ project: "vlad", title: "İş", kind: "dev", body: "" }, T0);
    setState(t.data.id, "running"); setState(t.data.id, "awaiting_approval"); setState(t.data.id, "done");
    setProjectSummary("vlad", "x", new Date(Date.now() + 1000));
    markDigested([t.data.id], new Date(Date.now() + 5000));
    expect(projectStatus("vlad").summary.newer).not.toContain(t.data.id);
  });
  it("setProjectSummary keeps frontmatter and other sections, replaces on rerun, rejects headings and oversize", () => {
    setProjectSummary("vlad", "bir", T0);
    setProjectSummary("vlad", "iki", T1);
    const raw = readFileSync(join(home, "kb", "projects", "vlad.md"), "utf8");
    expect(raw).toContain("## Özet\nx");
    expect(raw.match(/## Durum özeti/g)).toHaveLength(1);
    expect(raw).toContain("iki");
    expect(raw).not.toMatch(/^bir$/m);
    expect(() => setProjectSummary("vlad", "## Başlık\nx", T1)).toThrow(/başlık/);
    expect(() => setProjectSummary("vlad", "x".repeat(6001), T1)).toThrow(/uzun/);
    expect(() => setProjectSummary("yok", "x", T1)).toThrow(/bulunamadı/);
  });
});
