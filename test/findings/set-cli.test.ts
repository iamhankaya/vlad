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
const add = (title: string, sev = "düşük", src = "T20261109-01") =>
  JSON.parse(vlad(["finding", "add", "--project", "alpha", "--severity", sev, "--source", src, "--title", title, "--json"]).out).id as string;

beforeEach(() => {
  home = makeHome();
  expect(vlad(["project", "write", "alpha", "--file", "-"], card).code).toBe(0);
});

describe("finding set <id...> <durum> [--reason] (CLI)", () => {
  it("closes many ids at once, writes ## Kapanış and refreshes the card block", () => {
    const a = add("Birinci bulgu"), b = add("İkinci bulgu");
    expect(cardText()).toContain("Birinci bulgu");
    const r = vlad(["finding", "set", a, b, "wontfix", "--reason", "bulgu-tarama 2026-11-09: etkisiz", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).updated.map((x: { id: string }) => x.id)).toEqual([a, b]);
    expect(cardText()).not.toContain("Birinci bulgu");
    expect(readFileSync(join(home, "kb", "findings", `${a}.md`), "utf8")).toMatch(/## Kapanış\n- .* wontfix — bulgu-tarama 2026-11-09: etkisiz/);
  });
  it("single id keeps the original JSON shape", () => {
    const a = add("Tek");
    expect(JSON.parse(vlad(["finding", "set", a, "fixed", "--by", "T20261109-24", "--json"]).out)).toEqual({ id: a, state: "fixed", fixed_by: "T20261109-24" });
  });
  it("wontfix without --reason fails; one bad id writes nothing (exit 1)", () => {
    const a = add("Birinci");
    expect(vlad(["finding", "set", a, "wontfix"]).code).toBe(1);
    const r = vlad(["finding", "set", a, "F-alpha-099", "fixed"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("bulunamadı");
    expect(JSON.parse(vlad(["finding", "list", "--json"]).out).findings[0].state).toBe("open");
  });
  it("list --source / --older-than filter", () => {
    const a = add("A", "düşük", "T20261109-01"), b = add("B", "düşük", "T20261109-02");
    const ids = (extra: string[]) => (JSON.parse(vlad(["finding", "list", "--json", ...extra]).out).findings as { id: string }[]).map((f) => f.id);
    expect(ids(["--source", "T20261109-02"])).toEqual([b]);
    expect(ids(["--older-than", "1"])).toEqual([]);
    expect(ids(["--older-than", "0"])).toEqual([a, b]);
    expect(vlad(["finding", "list", "--older-than", "x"]).code).toBe(1);
  });
});
