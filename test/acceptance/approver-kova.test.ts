import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// approver-kabul: kova yer tutucusu (T20261116-04). `test/buckets.json` approver glob'larını sözleşme fazında bir kez ekler; kabul fazı kendi
// `approver-*.test.ts` dosyalarını ekleyince bu dosya silinebilir (glob'lar dosya bulmaya devam eder).
const buckets = JSON.parse(readFileSync(join(import.meta.dirname, "..", "buckets.json"), "utf8")) as Record<string, string[]>;
describe("approver-kabul: kova yerleşimi", () => {
  it("servis/exec spawn kapanımı ve kabul testleri process kovasında; VMT2 unit ve arch unit kovasında", () => {
    expect(buckets.process).toEqual(expect.arrayContaining(["test/approver/**/*.test.ts", "test/acceptance/approver-*.test.ts"]));
    expect(buckets.unit).toContain("test/mode/mode-token-vmt2.test.ts");
    expect(buckets.unit).toContain("test/arch/**/*.test.ts"); // approver-*.test.ts arch dosyalarını kapsar
  });
});
