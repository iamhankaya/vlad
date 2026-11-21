import { describe, expect, it } from "vitest";
import { execTimeoutFor } from "../../src/approver/exec.js";
import { LIMITS } from "../../src/approver/types.js";

// F-vlad-360: telefon onaylı yürütme süresi komutun manifest süre politikasından türer (en az LIMITS.execTimeoutMs).
describe("approver: yürütme zaman aşımı komut politikasından", () => {
  it("uzun komut (task gate) manifestin konsol süresini alır, 5 dk'ya kesilmez", () => {
    expect(execTimeoutFor(["task", "gate", "T1"])).toBe(31 * 60_000);
  });
  it("kısa/varsayılan komut en az LIMITS.execTimeoutMs alır", () => {
    expect(execTimeoutFor(["status"])).toBe(LIMITS.execTimeoutMs);
  });
  it("bilinmeyen komut taban değere düşer", () => {
    expect(execTimeoutFor(["yok", "boyle"])).toBe(LIMITS.execTimeoutMs);
  });
});
