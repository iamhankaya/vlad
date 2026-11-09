import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { spawnVlad } from "../support/spawn-vlad.js";

let home: string;
const card = "---\nslug: alpha\nname: Alpha\npath: C:\\dev\\alpha\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n\n## Açık konular\n- elle\n";
const vlad = (args: string[], input?: string) => {
  const r = spawnVlad({ args, input, env: { VLAD_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const cardText = () => readFileSync(join(home, "kb", "projects", "alpha.md"), "utf8");
const addIdea = (title: string) => JSON.parse(vlad(["idea", "add", "--project", "alpha", "--title", title, "--json"]).out).id as string;

beforeEach(() => {
  home = makeHome();
  expect(vlad(["project", "write", "alpha", "--file", "-"], card).code).toBe(0);
});

describe("vlad idea (CLI)", () => {
  it("add (detail from stdin) → list --json → set dropped → promote", () => {
    const r = vlad(["idea", "add", "--project", "alpha", "--title", "Dalga", "--detail-file", "-", "--source", "T20261110-08", "--json"], "uzun metin\n");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ id: "I-alpha-001" });
    const b = addIdea("İkinci");
    const list = JSON.parse(vlad(["idea", "list", "--project", "alpha", "--json"]).out);
    expect(list.ideas.map((i: { id: string }) => i.id)).toEqual(["I-alpha-001", b]);
    expect(list.ideas[0]).toMatchObject({ state: "open", source: "T20261110-08", detail: "uzun metin" });
    expect(vlad(["idea", "set", "I-alpha-001", "dropped"]).code).toBe(1); // reason required
    const s = vlad(["idea", "set", "I-alpha-001", "dropped", "--reason", "gereksiz", "--json"]);
    expect(JSON.parse(s.out)).toEqual({ id: "I-alpha-001", state: "dropped" });
    expect(JSON.parse(vlad(["idea", "list", "--state", "open", "--json"]).out).ideas).toHaveLength(1);
    expect(JSON.parse(vlad(["idea", "promote", b, "--task", "T20261110-09", "--json"]).out)).toEqual({ id: b, state: "promoted", task: "T20261110-09" });
    expect(vlad(["idea", "list", "--state", "bogus"]).code).toBe(1);
  });
  it("ideas stay out of the card's open findings block and project status counts them apart", () => {
    addIdea("Sadece fikir");
    expect(cardText()).not.toContain("Sadece fikir");
    const st = JSON.parse(vlad(["project", "status", "alpha", "--json"]).out);
    expect(st.ideas).toEqual({ open: 1 });
    expect(st.findings.counts).toEqual({});
  });
  it("from-finding moves findings into ideas and refreshes the card block", () => {
    const f = JSON.parse(vlad(["finding", "add", "--project", "alpha", "--severity", "bilgi", "--source", "T20261109-01", "--title", "Taşınacak bulgu", "--json"]).out).id as string;
    expect(cardText()).toContain("Taşınacak bulgu");
    const r = vlad(["idea", "from-finding", f, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ moved: [{ finding: f, idea: "I-alpha-001" }] });
    expect(cardText()).not.toContain("Taşınacak bulgu");
    expect(vlad(["idea", "from-finding", f]).code).toBe(1);
  });
  it("kb search/get/refs know the idea", () => {
    addIdea("Eşsizsözcük fikri");
    const hit = JSON.parse(vlad(["kb", "search", "eşsizsözcük", "--type", "idea", "--json"]).out);
    expect(hit[0] ?? hit.hits?.[0]).toMatchObject({ id: "I-alpha-001", type: "idea" });
    expect(vlad(["kb", "get", "I-alpha-001", "--json"]).code).toBe(0);
    expect(vlad(["kb", "refs", "I-alpha-001", "--json"]).code).toBe(0);
  });
});
