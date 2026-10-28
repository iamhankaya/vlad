import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { kbPaths } from "../../src/kb/index.js";
import { expireMode, modeStatus, parseUntil, setNight, setWatch, setOff, modeLine } from "../../src/mode/store.js";
import { statusSummary } from "../../src/tasks/launch.js";
import { defaultConfig } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

const now = new Date("2026-10-28T23:30:00+03:00");
const H = 3_600_000;

beforeEach(() => { makeHome(); });

describe("parseUntil", () => {
  it("HH:MM is the next such time: later today, else tomorrow", () => {
    expect(parseUntil("23:45", now).getTime()).toBe(now.getTime() + 15 * 60_000);
    expect(parseUntil("08:00", now).getTime()).toBe(now.getTime() + 8.5 * H);
  });
  it("accepts ISO and rejects junk or the past", () => {
    expect(parseUntil("2026-10-29T08:00:00+03:00", now).getTime()).toBe(now.getTime() + 8.5 * H);
    expect(() => parseUntil("sabah", now)).toThrow(/geçersiz/);
    expect(() => parseUntil("2026-10-28T20:00:00+03:00", now)).toThrow(/geçmiş/);
    expect(() => parseUntil("25:00", now)).toThrow(/geçersiz/);
  });
});

describe("mode state (kb/mode.json)", () => {
  it("is off by default", () => {
    expect(modeStatus(now)).toMatchObject({ night: null, watch: false, watching: false, expired: false });
    expect(modeLine(now)).toBeNull();
  });

  it("night sets window, projects and note; writes atomically (no temp leftovers)", () => {
    setNight({ until: "08:00", projects: ["vlad", "ashen-bastion"], note: "gece" }, now);
    const s = modeStatus(now);
    expect(s.night).toMatchObject({ projects: ["vlad", "ashen-bastion"], note: "gece" });
    expect(s.watching).toBe(true); // night implies watch
    expect(modeLine(now)).toMatch(/gece modu.*08:00/);
    expect(readdirSync(kbPaths().kb).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(kbPaths().kb, "mode.json"), "utf8")).night.until).toBeTruthy();
  });

  it("watch on/off works without night; off clears everything", () => {
    setWatch(true);
    expect(modeStatus(now)).toMatchObject({ night: null, watch: true, watching: true });
    setNight({ until: "08:00" }, now);
    setOff();
    expect(modeStatus(now)).toMatchObject({ night: null, watch: false, watching: false });
    expect(existsSync(join(kbPaths().kb, "mode.json"))).toBe(false);
  });

  it("an elapsed window reports expired; expireMode clears it once", () => {
    setNight({ until: "23:45" }, now);
    const later = new Date(now.getTime() + 20 * 60_000);
    const s = modeStatus(later);
    expect(s.night).toBeNull();
    expect(s.expired).toBe(true);
    expect(modeLine(later)).toMatch(/modu bitti/);
    expect(expireMode(later)).toBe(true);
    expect(expireMode(later)).toBe(false);
    expect(modeStatus(later).expired).toBe(false);
  });

  it("an expired night keeps an explicit watch flag", () => {
    setWatch(true);
    setNight({ until: "23:45" }, now);
    expireMode(new Date(now.getTime() + 20 * 60_000));
    expect(modeStatus(now).watch).toBe(true);
  });

  it("a corrupt file is reported, not thrown", () => {
    setWatch(true);
    writeFileSync(join(kbPaths().kb, "mode.json"), "{oops");
    expect(modeStatus(now)).toMatchObject({ night: null, watch: false });
  });
});

describe("statusSummary", () => {
  it("surfaces the active mode and clears an expired one", () => {
    setNight({ until: "23:45" }, now);
    expect(statusSummary(defaultConfig(), now, undefined, "linux").mode).toMatch(/gece modu/);
    const later = new Date(now.getTime() + 20 * 60_000);
    expect(statusSummary(defaultConfig(), later, undefined, "linux").mode).toMatch(/modu bitti/);
    expect(statusSummary(defaultConfig(), later, undefined, "linux").mode).toBeNull();
  });
});
