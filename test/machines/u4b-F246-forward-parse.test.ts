import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerState } from "../../src/agent/forward.js";
import { defaultConfig } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

// F-vlad-246: forward.ts config'i JSON.parse ile okur; ayrıştırılamayan config "unknown" (fail-closed), metin araması yok.
let home: string;
const saved = { m: process.env.VLAD_MACHINE, f: process.env.VLAD_FORWARDED };
beforeEach(() => { home = makeHome(); delete process.env.VLAD_MACHINE; delete process.env.VLAD_FORWARDED; });
afterEach(() => {
  for (const [k, v] of [["VLAD_MACHINE", saved.m], ["VLAD_FORWARDED", saved.f]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const writeCfg = (text: string) => writeFileSync(join(home, "vlad.config.json"), text);
const machines = [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "192.168.1.20", port: 7437 } }];

describe("workerState F-246 matrisi", () => {
  it("geçerli machines + işçi kimliği → worker", () => {
    writeCfg(JSON.stringify({ ...defaultConfig(), brain: "mac", machines })); process.env.VLAD_MACHINE = "windows";
    expect(workerState().kind).toBe("worker");
  });
  it("geçerli machines + beyin kimliği → brain", () => {
    writeCfg(JSON.stringify({ ...defaultConfig(), brain: "mac", machines })); process.env.VLAD_MACHINE = "mac";
    expect(workerState().kind).toBe("brain");
  });
  it("machines yok → off", () => {
    writeCfg(JSON.stringify(defaultConfig()));
    expect(workerState().kind).toBe("off");
  });
  it('dize değerinde "machines" (anahtar değil) → off', () => {
    writeCfg(JSON.stringify({ ...defaultConfig(), ignore: ["machines"] }));
    expect(workerState().kind).toBe("off");
  });
  it('yorumda "machines" (JSON geçersiz) → unknown', () => {
    writeCfg('{ // "machines" burada değil\n "brain": "mac" }');
    expect(workerState().kind).toBe("unknown");
  });
  it("bozuk JSON, 'machines' geçmiyor → unknown (eski metin araması off diyordu)", () => {
    writeCfg('{"brain": "mac", bozuk');
    expect(workerState().kind).toBe("unknown");
  });
  it("boş dosya → unknown", () => {
    writeCfg("");
    expect(workerState().kind).toBe("unknown");
  });
  it("kök nesne değil → unknown", () => {
    writeCfg("[]");
    expect(workerState().kind).toBe("unknown");
  });
  it("config dosyası yok → off; VLAD_FORWARDED → off (sıra korunur)", () => {
    expect(workerState().kind).toBe("off");
    writeCfg("{bozuk"); process.env.VLAD_FORWARDED = "1";
    expect(workerState().kind).toBe("off");
  });
});
