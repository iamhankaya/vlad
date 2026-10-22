import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths } from "../../src/kb/index.js";
import {
  addFinding, countOpenSevere, getFinding, listFindingsWithWarnings, parseFilter, setFindingState, SEVERITIES, STATES,
} from "../../src/findings/store.js";
import { makeHome } from "../helpers.js";

const add = (o: Partial<Parameters<typeof addFinding>[0]> = {}) =>
  addFinding({ project: "alpha", severity: "orta", source: "T20261022-01", title: "başlık", ...o });

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
  it("rejects an invalid severity, project slug, source task and empty title", () => {
    expect(() => add({ severity: "acil" })).toThrow(/geçersiz önem.*kritik/);
    expect(() => add({ project: "A b" })).toThrow(/slug/);
    expect(() => add({ source: "görev" })).toThrow(/source_task/);
    expect(() => add({ title: "  " })).toThrow();
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
