// Config overlay (T20261110-05): vlad.config.local.json tracked config üstüne sığ birleşir, null anahtarı siler; üç okuyucu aynı sonucu verir.
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resolveKbDir } from "../../src/kb/index.js";
import { loadLayeredConfig } from "../../src/setup/index.js";
import { workerState } from "../../src/agent/forward.js";

let home: string;
const w = (f: string, o: unknown) => writeFileSync(join(home, f), JSON.stringify(o));
const tracked = { roots: ["/r"], kbDir: "../kb-a", brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "win", os: "win32", agent: { host: "192.168.1.9", port: 7437 } }] };
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "vlad-cfglayer-")); cpSync(resolve(import.meta.dirname, "..", "..", "schemas"), join(home, "schemas"), { recursive: true }); vi.stubEnv("VLAD_HOME", home); vi.stubEnv("VLAD_KB_DIR", ""); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("config overlay", () => {
  it("overlay yokken loadLayeredConfig === loadConfig (derin eşit)", () => {
    w("vlad.config.json", tracked);
    expect(loadLayeredConfig(home)).toEqual(loadConfig(home));
  });
  it("overlay alanları sığ birleştirir", () => {
    w("vlad.config.json", tracked);
    w("vlad.config.local.json", { roots: ["/x"], launcher: "tmux" });
    const c = loadConfig(home);
    expect(c.roots).toEqual(["/x"]);
    expect(c.launcher).toBe("tmux");
    expect(c.brain).toBe("mac");
  });
  it("null anahtarı siler: machines+brain silinince checkMachines hata vermez", () => {
    w("vlad.config.json", tracked);
    w("vlad.config.local.json", { machines: null, brain: null });
    const c = loadConfig(home);
    expect(c.machines).toBeUndefined();
    expect(c.brain).toBeUndefined();
  });
  it("birleşim şemaya göre doğrulanır (bozuk overlay hata verir)", () => {
    w("vlad.config.json", tracked);
    w("vlad.config.local.json", { launcher: "nope" });
    expect(() => loadConfig(home)).toThrow();
  });
  it("bozuk overlay JSON'u dosya adıyla hata verir", () => {
    writeFileSync(join(home, "vlad.config.local.json"), "{x");
    expect(() => loadConfig(home)).toThrow(/vlad\.config\.local\.json/);
  });
  it("kbDir overlay'i resolveKbDir'a yansır", () => {
    w("vlad.config.json", tracked);
    w("vlad.config.local.json", { kbDir: "/abs/kb-b" });
    expect(resolveKbDir(home).dir).toBe("/abs/kb-b");
  });
  it("overlay machines'i silince workerState 'off' olur (forward.ts aynı kaynağı okur)", () => {
    w("vlad.config.json", tracked);
    w("vlad.config.local.json", { machines: null, brain: null });
    expect(workerState().kind).toBe("off");
  });
  it("yalnız overlay (tracked yok) varsayılanlar üstüne uygulanır", () => {
    mkdirSync(home, { recursive: true });
    w("vlad.config.local.json", { roots: ["/only"] });
    expect(loadConfig(home).roots).toEqual(["/only"]);
  });
});
