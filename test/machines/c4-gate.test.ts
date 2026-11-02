import { describe, expect, it } from "vitest";
import { OP_TABLE } from "../../src/agent/ops/index.js";
import { MERGE_EXTRA_ARGS, capText, checkExpectHead, checkMergeRefs, conflictsOf } from "../../src/agent/ops/gate.js";

const T = { id: "T20261101-33", parent: "T20261101-19", defaultBranch: "master" };

describe("machines:C4 kapı op'ları — saf yardımcılar", () => {
  it("checkMergeRefs: faz dalı → çatı dalı ve çatı dalı → kartın ana dalı kabul edilir", () => {
    expect(() => checkMergeRefs(T, "vlad/T20261101-33", "vlad/T20261101-19")).not.toThrow();
    expect(() => checkMergeRefs({ ...T, id: "T20261101-19", parent: null }, "vlad/T20261101-19", "master")).not.toThrow();
  });

  it("checkMergeRefs: görevin kendi dalı dışındaki kaynak, çatı/ana dal dışındaki hedef ve kötü ref bad_request", () => {
    const cases: [string, string][] = [
      ["vlad/T20261101-34", "vlad/T20261101-19"], // başka görevin dalı
      ["vlad/T20261101-33", "vlad/T20261101-20"], // başka çatı
      ["vlad/T20261101-33", "master"], // faz doğrudan ana dala (çatı varken)
      ["--upload-pack=calc", "vlad/T20261101-19"],
      ["vlad/T20261101-33", "-x"],
      ["vlad/T20261101-33 --no-ff", "vlad/T20261101-19"],
      ["vlad/T20261101-33", "../etc"],
      ["refs/heads/vlad/T20261101-33", "vlad/T20261101-19"],
    ];
    for (const [from, into] of cases) expect(() => checkMergeRefs(T, from, into), `${from} -> ${into}`).toThrow(/bad_request/);
  });

  it("checkMergeRefs: kartta ana dal yoksa ya da bozuksa ana dala merge reddedilir", () => {
    const root = { id: "T20261101-19", parent: null };
    expect(() => checkMergeRefs({ ...root }, "vlad/T20261101-19", "master")).toThrow(/bad_request/);
    expect(() => checkMergeRefs({ ...root, defaultBranch: "-evil" }, "vlad/T20261101-19", "-evil")).toThrow(/bad_request/);
  });

  it("checkExpectHead: aynı sha geçer; dal ilerlemişse reddedilir ve gate'in yeniden koşulması istenir", () => {
    const a = "a".repeat(40), b = "b".repeat(40);
    expect(() => checkExpectHead("vlad/T1", a, a)).not.toThrow();
    expect(() => checkExpectHead("vlad/T1", b, a)).toThrow(/yeniden koş/);
  });

  it("merge ek alanları expectHead içerir (merge op ve reconcile aynı listeyi kullanır)", () => {
    expect(MERGE_EXTRA_ARGS).toContain("expectHead");
    expect(MERGE_EXTRA_ARGS).toContain("message");
  });

  it("capText: sınır altı aynen; sınır üstü sondan kırpılır ve işaretlenir", () => {
    expect(capText("abc", 10)).toBe("abc");
    const r = capText("0123456789".repeat(10), 20);
    expect(r.endsWith("0123456789".repeat(2))).toBe(true);
    expect(r).toContain("kırpıldı");
  });

  it("conflictsOf: merge-tree --name-only çıktısından çakışan dosyalar (ilk satır ağaç kimliği)", () => {
    expect(conflictsOf("abc123\nsrc/a.ts\nsrc/b.ts\n")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(conflictsOf("abc123\n")).toEqual([]);
  });

  it("op tablosunda kapı op'ları artık notImplemented değil; bozuk argüman bad_request", async () => {
    for (const op of ["gate-run", "merge-preview", "merge"] as const) {
      await expect(OP_TABLE[op]({}, { from: "mac", opId: "x" }), op).rejects.toThrow(/bad_request/);
    }
  });
});
