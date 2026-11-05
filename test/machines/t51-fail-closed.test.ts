import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forwardIfWorker, WORKER_LOCAL } from "../../src/agent/forward.js";
import { readLocal } from "../../src/fleet/state.js";
import { readLocalSettings, resolveSelf } from "../../src/fleet/registry.js";
import { defaultConfig } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

// F-vlad-144: machines tanımlıyken kimlik/config okunamazsa kb yazıcıları fail-closed reddedilir; okuyucular çalışır.
let home: string;
const saved = { m: process.env.VLAD_MACHINE, l: process.env.VLAD_LOCAL_FILE, f: process.env.VLAD_FORWARDED };
beforeEach(() => { home = makeHome(); for (const k of ["VLAD_MACHINE", "VLAD_LOCAL_FILE", "VLAD_FORWARDED"]) delete process.env[k]; });
afterEach(() => {
  for (const [k, v] of [["VLAD_MACHINE", saved.m], ["VLAD_LOCAL_FILE", saved.l], ["VLAD_FORWARDED", saved.f]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
const cfgJson = { ...defaultConfig(), brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "192.168.1.20", port: 7437 } }] };
const writeCfg = (text: string) => writeFileSync(join(home, "vlad.config.json"), text);
const writeLocalFile = (text: string) => writeFileSync(join(home, "vlad.local.json"), text);

const WRITERS = ["project write", "finding add", "decision add", "journal append", "task new", "task set", "task launch", "kb commit"];
const READERS = ["task list", "kb get", "finding list", "decision list", "project status"];

describe("machines:T51 fail-closed", () => {
  const bad: [string, () => void][] = [
    ["bozuk vlad.local.json", () => { writeCfg(JSON.stringify(cfgJson)); writeLocalFile("{bozuk"); }],
    ["eksik kimlik", () => { writeCfg(JSON.stringify(cfgJson)); }],
    ["config'te tanımsız kimlik", () => { writeCfg(JSON.stringify(cfgJson)); process.env.VLAD_MACHINE = "ghost"; }],
    ["bozuk config (machines geçiyor)", () => { writeCfg('{"machines": [ bozuk'); process.env.VLAD_MACHINE = "windows"; }],
  ];
  for (const [name, setup] of bad) {
    it(`${name}: her kb yazıcısı reddedilir`, async () => {
      setup();
      for (const k of WRITERS) await expect(forwardIfWorker(k, [{}, {}]), k).rejects.toThrow(/kimlik|config|reddedildi/i);
    });
    it(`${name}: okuyucular çalışır`, async () => {
      setup();
      for (const k of READERS) { expect(WORKER_LOCAL.has(k), k).toBe(true); expect(await forwardIfWorker(k, [{}, {}]), k).toBe(false); }
    });
  }
  it("machines yoksa (tek makine) yazıcılar etkilenmez", async () => {
    writeCfg(JSON.stringify(defaultConfig()));
    expect(await forwardIfWorker("task new", [{}, {}])).toBe(false);
  });
  it("beyin kimliği çözülünce yazıcılar yerelde çalışır", async () => {
    writeCfg(JSON.stringify(cfgJson)); process.env.VLAD_MACHINE = "mac";
    expect(await forwardIfWorker("task new", [{}, {}])).toBe(false);
  });
  it("tek kimlik çözümleyici: iki çağıran aynı sonucu verir", () => {
    writeLocalFile(JSON.stringify({ self: "windows", keys: { a: "k" }, extra: 1 }));
    expect(readLocalSettings()).toEqual(readLocal());
    expect(resolveSelf(cfgJson as any)).toBe("windows");
    writeLocalFile("{bozuk");
    expect(() => readLocalSettings()).toThrow(/vlad\.local\.json/);
    expect(() => readLocal()).toThrow(/vlad\.local\.json/);
  });
});
