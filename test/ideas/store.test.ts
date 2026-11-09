import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, validate } from "../../src/kb/index.js";
import { addFinding, getFinding } from "../../src/findings/store.js";
import { addIdea, fromFindings, getIdea, listIdeas, promoteIdea, setIdeaStates } from "../../src/ideas/store.js";
import { getKbRecord } from "../../src/kb/get.js";
import { searchKb } from "../../src/kb/search.js";
import { refsOf, recordStates } from "../../src/kb/refs.js";
import { maintainKb } from "../../src/kb/maintain.js";
import { makeHome } from "../helpers.js";

const card = (p: string) => writeFileSync(join(kbPaths().projects, `${p}.md`), "---\nslug: x\n---\n");
const add = (o: Partial<Parameters<typeof addIdea>[0]> = {}) => {
  card(o.project ?? "alpha");
  return addIdea({ project: "alpha", title: "Fikir başlığı", ...o });
};

describe("ideas store", () => {
  beforeEach(() => { makeHome(); });

  it("adds an idea with per-project I- id, open state, detail body", () => {
    const a = add({ detail: "ayrıntı\n", source: "T20261110-08" });
    expect(a.data).toMatchObject({ id: "I-alpha-001", project: "alpha", state: "open", title: "Fikir başlığı", source: "T20261110-08" });
    expect(a.data.created).toBe(a.data.updated);
    expect(readFileSync(a.file, "utf8")).toContain("## Ayrıntı\nayrıntı\n");
    expect(add().data.id).toBe("I-alpha-002");
    expect(add({ project: "beta" }).data.id).toBe("I-beta-001");
  });
  it("source is optional and may be a finding id", () => {
    expect(add().data.source ?? null).toBeNull();
    expect(add({ source: "F-alpha-003" }).data.source).toBe("F-alpha-003");
    expect(() => add({ source: "bogus" })).toThrow(/doğrulama/);
  });
  it("rejects missing card and bad slug", () => {
    expect(() => addIdea({ project: "yok", title: "x" })).toThrow(/proje kartı bulunamadı: yok/);
    expect(() => addIdea({ project: "Bad_Slug", title: "x" })).toThrow(/geçersiz proje slug/);
    expect(() => add({ title: "  " })).toThrow(/başlık/);
  });
  it("lists with project/state filters", () => {
    add(); add({ project: "beta" }); add();
    setIdeaStates(["I-alpha-002"], "dropped", { reason: "gereksiz" });
    expect(listIdeas().ideas.map((i) => i.data.id)).toEqual(["I-alpha-001", "I-alpha-002", "I-beta-001"]);
    expect(listIdeas({ project: "alpha", state: ["open"] }).ideas.map((i) => i.data.id)).toEqual(["I-alpha-001"]);
  });
  it("drop needs a reason, writes ## Kapanış, all-or-nothing", () => {
    add(); add();
    expect(() => setIdeaStates(["I-alpha-001"], "dropped", {})).toThrow(/--reason zorunlu/);
    expect(() => setIdeaStates(["I-alpha-001", "I-alpha-099"], "dropped", { reason: "x" })).toThrow(/fikir bulunamadı/);
    expect(getIdea("I-alpha-001").data.state).toBe("open");
    setIdeaStates(["I-alpha-001", "I-alpha-002"], "dropped", { reason: "kapsam dışı" });
    const i = getIdea("I-alpha-001");
    expect(i.data.state).toBe("dropped");
    expect(i.body).toMatch(/## Kapanış\n- .* dropped — kapsam dışı/);
  });
  it("set only allows dropped (promoted goes through promote); can reopen nothing", () => {
    add();
    expect(() => setIdeaStates(["I-alpha-001"], "promoted", { reason: "x" })).toThrow(/geçersiz durum/);
    expect(() => setIdeaStates(["I-alpha-001"], "bogus", { reason: "x" })).toThrow(/geçersiz durum/);
  });
  it("promote records the task id and state", () => {
    add();
    mkdirSync(kbPaths().tasks, { recursive: true });
    writeFileSync(join(kbPaths().tasks, "T20261110-09.md"), `---\nid: T20261110-09\nproject: alpha\ntitle: t\nkind: dev\nstate: queued\nautonomy: commit\ncreated: "2026-11-10T00:00:00+03:00"\nupdated: "2026-11-10T00:00:00+03:00"\n---\n\n## Tanım\nx\n`);
    const p = promoteIdea("I-alpha-001", "T20261110-09");
    expect(p.data).toMatchObject({ state: "promoted", promoted_task: "T20261110-09" });
    expect(p.body).toMatch(/## Kapanış\n- .* promoted — T20261110-09/);
    expect(() => promoteIdea("I-alpha-001", "T20261110-10")).toThrow(/yalnız open/);
    add();
    expect(() => promoteIdea("I-alpha-002", "bogus")).toThrow(/görev ID/);
  });
  it("from-finding opens ideas and wontfixes findings, all-or-nothing", () => {
    card("alpha");
    const f1 = addFinding({ project: "alpha", severity: "bilgi", source: "T20261109-01", title: "Bir fikir", detail: "uzun ayrıntı" });
    const f2 = addFinding({ project: "alpha", severity: "düşük", source: "T20261109-01", title: "İkinci fikir" });
    const r = fromFindings([f1.data.id, f2.data.id]);
    expect(r.map((x) => x.idea.data.id)).toEqual(["I-alpha-001", "I-alpha-002"]);
    expect(r[0]!.idea.data).toMatchObject({ title: "Bir fikir", source: f1.data.id });
    expect(r[0]!.idea.body).toContain("uzun ayrıntı");
    const body = readFileSync(join(kbPaths().findings, `${f1.data.id}.md`), "utf8");
    expect(body).toContain("state: wontfix");
    expect(body).toContain("fikir deposuna taşındı: I-alpha-001");
    // closed finding cannot be moved again; nothing is written when any id fails
    const f3 = addFinding({ project: "alpha", severity: "bilgi", source: "T20261109-01", title: "Üçüncü" });
    expect(() => fromFindings([f3.data.id, f1.data.id])).toThrow(/açık değil/);
    expect(() => fromFindings([f3.data.id, "F-alpha-099"])).toThrow(/bulgu bulunamadı/);
    expect(listIdeas().ideas).toHaveLength(2);
    expect(readFileSync(join(kbPaths().findings, `${f3.data.id}.md`), "utf8")).toContain("state: open");
  });
  it("from-finding reuses an open idea of the same source (re-run after a failed finding write leaves no twin)", () => {
    card("alpha");
    const f = addFinding({ project: "alpha", severity: "bilgi", source: "T20261109-01", title: "Tekrar" });
    const pre = addIdea({ project: "alpha", title: "Tekrar", source: f.data.id }); // what a half-done first run leaves behind
    const r = fromFindings([f.data.id]);
    expect(r[0]!.idea.data.id).toBe(pre.data.id);
    expect(listIdeas().ideas).toHaveLength(1);
    expect(getFinding(f.data.id).data.state).toBe("wontfix");
  });
  it("promote checks the task exists and belongs to the idea's project", () => {
    add();
    expect(() => promoteIdea("I-alpha-001", "T20261110-77")).toThrow(/görev bulunamadı/);
    const dir = kbPaths().tasks; mkdirSync(dir, { recursive: true });
    const mk = (id: string, project: string) => writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\nproject: ${project}\ntitle: t\nkind: dev\nstate: queued\nautonomy: commit\ncreated: "2026-11-10T00:00:00+03:00"\nupdated: "2026-11-10T00:00:00+03:00"\n---\n\n## Tanım\nx\n`);
    mk("T20261110-71", "beta");
    expect(() => promoteIdea("I-alpha-001", "T20261110-71")).toThrow(/başka projenin/);
    mk("T20261110-72", "alpha");
    expect(promoteIdea("I-alpha-001", "T20261110-72").data.state).toBe("promoted");
  });
  it("schema rejects bad state and id", () => {
    const d = { id: "I-a-001", project: "a", title: "t", state: "open", created: "2026-11-10T00:00:00+03:00", updated: "2026-11-10T00:00:00+03:00" };
    expect(() => validate("idea", d)).not.toThrow();
    expect(() => validate("idea", { ...d, state: "fixed" })).toThrow();
    expect(() => validate("idea", { ...d, id: "F-a-001" })).toThrow();
  });
});

describe("kb knows ideas", () => {
  beforeEach(() => { makeHome(); });
  it("kb get reads an idea (live and archived)", () => {
    add({ detail: "gövde" });
    const r = getKbRecord("I-alpha-001", "## Ayrıntı");
    expect(r).toMatchObject({ kind: "idea", archived: false });
    expect(r.content).toContain("gövde");
  });
  it("kb search type idea", () => {
    add({ title: "Benzersizkelime önerisi" });
    const hits = searchKb({ query: "benzersizkelime", type: "idea" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "I-alpha-001", type: "idea", project: "alpha", status: "open" });
    expect(searchKb({ query: "benzersizkelime", type: "finding" })).toHaveLength(0);
  });
  it("kb refs resolves an idea and recordStates lists it", () => {
    add();
    expect(refsOf("I-alpha-001")).toMatchObject({ id: "I-alpha-001", type: "idea", status: "open", project: "alpha" });
    expect(recordStates().get("I-alpha-001")).toMatchObject({ type: "idea", status: "open" });
  });
  it("kb maintain archives settled ideas and reads them transparently", () => {
    add(); add();
    setIdeaStates(["I-alpha-001"], "dropped", { reason: "x" }, new Date("2026-01-01T00:00:00+03:00"));
    const r = maintainKb({ days: 30 });
    expect(r.ideas.map((x) => x.id)).toEqual(["I-alpha-001"]);
    expect(existsSync(join(kbPaths().ideas, "archive", "2026-01", "I-alpha-001.md"))).toBe(true);
    expect(getIdea("I-alpha-001").data.state).toBe("dropped");
    expect(add().data.id).toBe("I-alpha-003"); // archived id is not reused
    expect(getKbRecord("I-alpha-001").archived).toBe(true);
    mkdirSync(kbPaths().ideas, { recursive: true });
  });
});
