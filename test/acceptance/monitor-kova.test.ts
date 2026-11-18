import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// monitor-kabul: kova yer tutucusu (T20261119-20). `test/buckets.json` monitor glob'larını sözleşme fazında bir kez ekler; kabul fazı kendi
// `monitor-*.test.ts` dosyalarını ekleyince bu dosya silinebilir (glob'lar dosya bulmaya devam eder).
const buckets = JSON.parse(readFileSync(join(import.meta.dirname, "..", "buckets.json"), "utf8")) as Record<string, string[]>;
describe("monitor-kabul: kova yerleşimi", () => {
  it("sahte ajan HTTP sunucusu ve launchctl sahtesi kullanan testler process kovasında", () => {
    expect(buckets.process).toEqual(expect.arrayContaining(["test/monitor/**/*.test.ts", "test/acceptance/monitor-*.test.ts"]));
  });
});
