import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths } from "../../src/kb/index.js";
import {
  addFinding, countOpenSevere, getFinding, listFindingsWithWarnings, parseFilter, setFindingState, setFindingStates, SEVERITIES, STATES,
} from "../../src/findings/store.js";
import { makeHome } from "../helpers.js";

// addFinding requires an existing project card; only its presence matters here
const add = (o: Partial<Parameters<typeof addFinding>[0]> = {}) => {
  const project = o.project ?? "alpha";
  if (/^[a-z0-9-]+$/.test(project)) writeFileSync(join(kbPaths().projects, `${project}.md`), "---\nslug: x\n---\n");
  return addFinding({ severity: "orta", source: "T20261022-01", title: "başlık", ...o, project });
};

describe("findings store", () => {
  beforeEach(() => { makeHome(); });

  it("adds a finding with a per-project id, open state, detail body and dates", () => {
    const a = add({ detail: "ayrıntı metni\n" });
    expect(a.data).toMatchObject({ id: "F-alpha-001", project: "alpha", severity: "orta", state: "open", source_task: "T20261022-01", title: "başlık" });
    expect(a.data.created).toBe(a.data.updated);
    expect(readFileSync(a.file, "utf8")).toContain("## Ayrıntı\nayrıntı metni\n");
    expect(add().data.id).toBe("F-alpha-002");
    expect(add({ project: "beta" }).data.id).toBe("F-beta-001");
  });
  it("does not mix ids of projects whose slug is a prefix of another", () => {
    add({ project: "man" });
    expect(add({ project: "man-ga" }).data.id).toBe("F-man-ga-001");
    expect(add({ project: "man" }).data.id).toBe("F-man-002");
  });
  it("accepts deferred as the initial state and rejects fixed/wontfix", () => {
    expect(add({ state: "deferred" }).data.state).toBe("deferred");
    expect(() => add({ state: "fixed" })).toThrow(/open\|deferred/);
  });
  it("rejects a project without a card with the same message as project set/note", () => {
    expect(() => addFinding({ project: "yok", severity: "orta", source: "T20261022-01", title: "x" })).toThrow(/proje kartı bulunamadı: yok/);
  });

  it("rejects an invalid severity, project slug, source task and empty title", () => {
    expect(() => add({ severity: "acil" })).toThrow(/geçersiz önem.*kritik/);
    expect(() => add({ project: "A b" })).toThrow(/slug/);
    expect(() => add({ source: "görev" })).toThrow(/source_task/);
    expect(() => add({ title: "  " })).toThrow();
  });
  it("project filter keeps prefix-sharing slugs apart and does not read other projects' files", () => {
    add({ project: "man" });
    add({ project: "man-ga" });
    writeFileSync(join(kbPaths().findings, "F-other-001.md"), "bozuk");
    const r = listFindingsWithWarnings({ project: "man" });
    expect(r.findings.map((x) => x.data.id)).toEqual(["F-man-001"]);
    expect(r.warnings).toEqual([]);
    expect(listFindingsWithWarnings({ project: "man-ga" }).findings.map((x) => x.data.id)).toEqual(["F-man-ga-001"]);
  });
  it("lists in id order and filters by project, state and severity", () => {
    add({ severity: "kritik" });
    add({ severity: "düşük", state: "deferred" });
    add({ project: "beta", severity: "yüksek" });
    const ids = (f?: Parameters<typeof listFindingsWithWarnings>[0]) => listFindingsWithWarnings(f).findings.map((x) => x.data.id);
    expect(ids()).toEqual(["F-alpha-001", "F-alpha-002", "F-beta-001"]);
    expect(ids({ project: "alpha" })).toEqual(["F-alpha-001", "F-alpha-002"]);
    expect(ids({ state: ["deferred"] })).toEqual(["F-alpha-002"]);
    expect(ids({ severity: ["kritik", "yüksek"] })).toEqual(["F-alpha-001", "F-beta-001"]);
    expect(ids({ project: "alpha", state: ["open"], severity: ["düşük"] })).toEqual([]);
  });
  it("returns nothing when kb/findings does not exist", () => {
    expect(listFindingsWithWarnings()).toEqual({ findings: [], warnings: [] });
  });
  it("skips broken files and reports them as warnings", () => {
    add();
    writeFileSync(join(kbPaths().findings, "F-alpha-009.md"), "---\nid: F-alpha-009\n---\n");
    const r = listFindingsWithWarnings();
    expect(r.findings).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
  });
  it("sets state; fixed records fixed_by and date, reopening clears them", () => {
    const a = add();
    const f = setFindingState(a.data.id, "fixed", "T20261022-02");
    expect(f.data).toMatchObject({ state: "fixed", fixed_by: "T20261022-02" });
    expect(f.data.fixed).toBeTruthy();
    expect(getFinding(a.data.id).data.fixed_by).toBe("T20261022-02");
    const g = setFindingState(a.data.id, "open");
    expect(g.data.fixed_by).toBeUndefined();
    expect(g.data.fixed).toBeUndefined();
    expect(setFindingState(a.data.id, "wontfix").data.state).toBe("wontfix");
    expect(readFileSync(a.file, "utf8")).toContain("## Ayrıntı");
  });
  it("fixed without --by is allowed", () => {
    const a = add();
    expect(setFindingState(a.data.id, "fixed").data.fixed_by).toBeUndefined();
  });
  it("rejects invalid state, --by on a non-fixed state, bad fixed_by and unknown ids", () => {
    const a = add();
    expect(() => setFindingState(a.data.id, "closed")).toThrow(/geçersiz durum.*open/);
    expect(() => setFindingState(a.data.id, "wontfix", "T20261022-02")).toThrow(/--by/);
    expect(() => setFindingState(a.data.id, "fixed", "x")).toThrow();
    expect(() => setFindingState("F-alpha-099", "fixed")).toThrow(/bulunamadı/);
    expect(() => setFindingState("../x", "fixed")).toThrow(/bulunamadı/);
    expect(getFinding(a.data.id).data.state).toBe("open");
  });
  it("counts open and deferred critical/high findings only", () => {
    add({ severity: "kritik" });
    add({ severity: "yüksek", state: "deferred" });
    add({ severity: "orta" });
    const done = add({ severity: "yüksek" });
    setFindingState(done.data.id, "fixed");
    expect(countOpenSevere()).toBe(2);
  });
  it("parseFilter splits, trims and rejects unknown values", () => {
    expect(parseFilter("open, deferred", STATES, "durum")).toEqual(["open", "deferred"]);
    expect(() => parseFilter("open,x", SEVERITIES, "önem")).toThrow(/geçersiz önem: open, x/);
  });
});

describe("setFindingStates (toplu)", () => {
  beforeEach(() => { makeHome(); });
  const NOW = new Date("2026-11-09T12:00:00+03:00");

  it("sets many ids at once and writes a ## Kapanış section with date, state, reason and source", () => {
    const a = add(), b = add({ project: "beta" });
    const r = setFindingStates([a.data.id, b.data.id], "wontfix", { reason: "bulgu-tarama: etkisiz", by: undefined }, NOW);
    expect(r.map((f) => f.data.state)).toEqual(["wontfix", "wontfix"]);
    const text = readFileSync(a.file, "utf8");
    expect(text).toContain("## Ayrıntı");
    expect(text).toMatch(/## Kapanış\n- 2026-11-09.* wontfix — bulgu-tarama: etkisiz/);
    expect(getFinding(b.data.id).data.state).toBe("wontfix");
  });
  it("wontfix requires a reason", () => {
    const a = add();
    expect(() => setFindingStates([a.data.id], "wontfix", {}, NOW)).toThrow(/--reason/);
    expect(getFinding(a.data.id).data.state).toBe("open");
  });
  it("fixed records --by as source and fixed_by", () => {
    const a = add();
    setFindingStates([a.data.id], "fixed", { by: "T20261109-24", reason: "kodda düzeltilmiş: abc123" }, NOW);
    expect(getFinding(a.data.id).data.fixed_by).toBe("T20261109-24");
    expect(readFileSync(a.file, "utf8")).toContain("kaynak: T20261109-24");
  });
  it("all-or-nothing: one unknown id writes none", () => {
    const a = add();
    expect(() => setFindingStates([a.data.id, "F-alpha-099"], "wontfix", { reason: "x" }, NOW)).toThrow(/bulunamadı: F-alpha-099/);
    expect(getFinding(a.data.id).data.state).toBe("open");
    expect(readFileSync(a.file, "utf8")).not.toContain("Kapanış");
  });
  it("all-or-nothing: invalid state or --by on non-fixed writes none; duplicates are collapsed", () => {
    const a = add();
    expect(() => setFindingStates([a.data.id], "closed", {}, NOW)).toThrow(/geçersiz durum/);
    expect(() => setFindingStates([a.data.id], "wontfix", { by: "T20261109-24", reason: "x" }, NOW)).toThrow(/--by/);
    expect(setFindingStates([a.data.id, a.data.id], "wontfix", { reason: "x" }, NOW)).toHaveLength(1);
    expect(readFileSync(a.file, "utf8").match(/## Kapanış/g)).toHaveLength(1);
  });
  it("a reopen reason is recorded too", () => {
    const a = add();
    setFindingStates([a.data.id], "wontfix", { reason: "x" }, NOW);
    setFindingStates([a.data.id], "open", { reason: "yanlış kapanmıştı" }, NOW);
    expect(readFileSync(a.file, "utf8")).toContain("open — yanlış kapanmıştı");
  });
  it("reopening needs no reason and keeps the closing history", () => {
    const a = add();
    setFindingStates([a.data.id], "wontfix", { reason: "x" }, NOW);
    setFindingStates([a.data.id], "open", {}, NOW);
    expect(getFinding(a.data.id).data.state).toBe("open");
    expect(readFileSync(a.file, "utf8")).toContain("wontfix — x");
  });
  it("rejects an empty id list", () => {
    expect(() => setFindingStates([], "fixed", {}, NOW)).toThrow(/bulgu ID/);
  });
});

describe("listFindingsWithWarnings: --older-than / --source", () => {
  beforeEach(() => { makeHome(); });
  it("filters by age in days (created) and by source task", () => {
    const NOW = new Date(Date.now() + 3_600_000); // after both findings were created
    const old = add({ source: "T20261001-01" }), fresh = add({ source: "T20261108-01" });
    // age the first one
    const t = readFileSync(old.file, "utf8").replace(/created: .*/, `created: ${new Date(NOW.getTime() - 40 * 86_400_000).toISOString()}`);
    writeFileSync(old.file, t);
    const ids = (f: Parameters<typeof listFindingsWithWarnings>[0]) => listFindingsWithWarnings(f).findings.map((x) => x.data.id);
    expect(ids({ olderThanDays: 30, now: NOW })).toEqual([old.data.id]);
    expect(ids({ olderThanDays: 0, now: NOW })).toEqual([old.data.id, fresh.data.id]);
    expect(ids({ source: "T20261108-01" })).toEqual([fresh.data.id]);
    expect(ids({ olderThanDays: 30, source: "T20261108-01", now: NOW })).toEqual([]);
  });
});
