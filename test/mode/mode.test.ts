import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { kbPaths } from "../../src/kb/index.js";
import { DEFAULT_EXCEPT, assertNotWorker, expireMode, modeStatus, parseUntil, setNight, setWatch, setOff, modeLine } from "../../src/mode/store.js";
import { createTask, getTask, saveTask } from "../../src/tasks/store.js";
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
  it("ISO beyond 24h is rejected (F-vlad-088: there was no upper bound)", () => {
    expect(parseUntil("2026-10-29T23:00:00+03:00", now).getTime()).toBe(now.getTime() + 23.5 * H);
    expect(() => parseUntil("2026-11-05T08:00:00+03:00", now)).toThrow(/24 saat/);
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

describe("M1: push yetkisi ve istisnalar (T20261109-22)", () => {
  it("push varsayılan kapalı; eski mode.json (alansız) push:false okunur", () => {
    setNight({ until: "08:00" }, now);
    expect(modeStatus(now).night).toMatchObject({ push: false, except: [...DEFAULT_EXCEPT] });
    writeFileSync(join(kbPaths().kb, "mode.json"), JSON.stringify({ night: { until: "2026-10-29T08:00:00+03:00", started: "x", projects: [], note: null }, watch: false }));
    expect(modeStatus(now).night).toMatchObject({ push: false, untilTasks: [] });
  });

  it("--push ve --except mode.json'a yazılır; varsayılan istisnalar asla kaldırılamaz", () => {
    setNight({ until: "08:00", push: true, except: ["ödeme", " deploy "] }, now);
    const n = JSON.parse(readFileSync(join(kbPaths().kb, "mode.json"), "utf8")).night;
    expect(n.push).toBe(true);
    expect(n.except).toEqual(expect.arrayContaining(["deploy", "backfill", "keychain", "ödeme"]));
    expect(n.except.filter((x: string) => x === "deploy")).toHaveLength(1);
  });

  it("satır push yetkisini ve istisnaları gösterir; push yoksa 'push yok' der", () => {
    setNight({ until: "08:00", push: true, except: ["ödeme"] }, now);
    expect(modeLine(now)).toMatch(/push yetkisi.*gate\/CI yeşil.*P1.*istisna: .*deploy.*ödeme/);
    expect(modeLine(now)).toMatch(/tüm projeler/); // push + boş --projects = hepsi: satır bunu açıkça söyler
    setNight({ until: "08:00", push: true, projects: ["vlad"] }, now);
    expect(modeLine(now)).not.toMatch(/tüm projeler/);
    setNight({ until: "08:00" }, now);
    expect(modeLine(now)).toMatch(/push yok/);
  });
});

describe("M2: görev bağlı pencere (T20261109-22)", () => {
  const mk = (t: string) => createTask({ project: "alpha", title: t, kind: "dev", body: "" }).data.id;
  const finish = (id: string, state: "done" | "cancelled") => { const t = getTask(id); t.data.state = state; saveTask(t); };

  it("listedeki tüm görevler done/cancelled olunca pencere kapanır", () => {
    const a = mk("a"), b = mk("b");
    setNight({ untilTasks: [a, b] }, now);
    expect(modeStatus(now)).toMatchObject({ remaining: [a, b], expired: false });
    expect(modeLine(now)).toMatch(new RegExp(`${a}.*${b}`));
    finish(a, "done");
    expect(modeStatus(now).remaining).toEqual([b]);
    expect(modeStatus(now).night).not.toBeNull();
    finish(b, "cancelled");
    const s = modeStatus(now);
    expect(s.night).toBeNull();
    expect(s.expired).toBe(true);
    expect(modeLine(now)).toMatch(/görevler bitti/);
    expect(expireMode(now)).toBe(true);
  });

  it("--until ile birlikte hangisi önce gelirse: süre önce dolarsa açık görev uyarısı", () => {
    const a = mk("a");
    setNight({ until: "23:45", untilTasks: [a] }, now);
    const later = new Date(now.getTime() + 20 * 60_000);
    expect(modeStatus(later).expired).toBe(true);
    expect(modeLine(later)).toMatch(new RegExp(`süre doldu.*${a}.*yenile`));
  });

  it("yalnız --until-task: 24 saat güvenlik tavanı; aşılınca açık görevle uyarı", () => {
    const a = mk("a");
    const n = setNight({ untilTasks: [a] }, now);
    expect(Date.parse(n.until) - now.getTime()).toBe(24 * H);
    const later = new Date(now.getTime() + 24 * H + 1000);
    expect(modeStatus(later).night).toBeNull();
    expect(modeLine(later)).toMatch(/tavan|süre doldu/);
  });

  it("bilinmeyen görev ID'si ve boş (until yok, görev yok) reddedilir", () => {
    expect(() => setNight({ untilTasks: ["T20990101-99"] }, now)).toThrow(/görev bulunamadı/);
    expect(() => setNight({}, now)).toThrow(/--until|--until-task/);
  });
});

describe("mod güvenliği (T20261109-30: F-vlad-282/285/286)", () => {
  const mk = (t: string) => createTask({ project: "alpha", title: t, kind: "dev", body: "" }).data.id;

  it("F-282: VLAD_TASK_ID tanımlıyken yazma komutları reddedilir", () => {
    expect(() => assertNotWorker({ VLAD_TASK_ID: "T20261109-30" })).toThrow(/çalışan/);
    expect(() => assertNotWorker({})).not.toThrow();
    expect(() => assertNotWorker({ VLAD_TASK_ID: " " })).not.toThrow();
  });

  it("F-285: --except biçimi doğrulanır, küçük harfe çevrilir; --until-task biçimi doğrulanır", () => {
    expect(() => setNight({ until: "08:00", except: ["a b"] }, now)).toThrow(/geçersiz istisna/);
    expect(setNight({ until: "08:00", except: ["Mail"] }, now).except).toContain("mail");
    expect(() => setNight({ untilTasks: ["../x"] }, now)).toThrow(/geçersiz görev/);
  });

  it("F-285: tarih-yalnız --until yerel gece yarısı çözülür (UTC değil)", () => {
    const n = new Date(2026, 9, 28, 23, 30);
    expect(parseUntil("2026-10-29", n).getTime()).toBe(new Date(2026, 9, 29, 0, 0).getTime());
  });

  it("F-286: failed görev pencereyi kapatır", () => {
    const a = mk("a");
    setNight({ untilTasks: [a] }, now);
    const t = getTask(a); t.data.state = "failed"; saveTask(t);
    expect(modeStatus(now)).toMatchObject({ night: null, expired: true, remaining: [] });
  });

  it("F-286: setWatch dolmuş pencereyi düşürdüğünü bildirir", () => {
    setNight({ until: "23:45" }, now);
    const later = new Date(now.getTime() + 20 * 60_000);
    expect(setWatch(true, later)).toBe(true);
    expect(setWatch(true, later)).toBe(false);
  });
});
