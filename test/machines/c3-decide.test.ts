import { describe, expect, it } from "vitest";
import { decideSilent } from "../../src/tasks/liveness.js";

const MIN = 60_000;
const silentMs = 15 * MIN;

describe("machines:C3 decideSilent (saf çekirdek)", () => {
  it("grace dolmadan (5 dk) süreç yok olsa da stalled değil", () => {
    expect(decideSilent({ idleMs: 4 * MIN, alive: false, silentMs })).toBe(false);
  });
  it("grace sonrası süreç yoksa stalled", () => {
    expect(decideSilent({ idleMs: 6 * MIN, alive: false, silentMs })).toBe(true);
  });
  it("süreç var: eşiğin 4 katına kadar canlı sayılır", () => {
    expect(decideSilent({ idleMs: 59 * MIN, alive: true, silentMs })).toBe(false);
    expect(decideSilent({ idleMs: 60 * MIN, alive: true, silentMs })).toBe(true);
  });
  it("süreç listesi yok (null): yalnız tek eşik", () => {
    expect(decideSilent({ idleMs: 14 * MIN, alive: null, silentMs })).toBe(false);
    expect(decideSilent({ idleMs: 15 * MIN, alive: null, silentMs })).toBe(true);
  });
  it("eşik grace'ten küçükse grace eşiğe iner", () => {
    expect(decideSilent({ idleMs: 2 * MIN, alive: false, silentMs: 2 * MIN })).toBe(true);
  });
});
