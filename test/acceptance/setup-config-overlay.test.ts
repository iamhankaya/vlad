// Kabul (T20261110-04; spec T20261110-02) S12 (regresyon) + S13: vlad.config.local.json overlay'i; üç okuyucu aynı sonucu verir.
// Uygulama 4a (T20261110-05) gelene dek KIRMIZI: loadLayeredConfig gövdesi "not implemented".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workerState } from "../../src/agent/forward.js";
import { loadConfig, resolveKbDir } from "../../src/kb/index.js";
import { LOCAL_CONFIG_FILE, loadLayeredConfig } from "../../src/setup/index.js";
import { makeHome } from "../helpers.js";

const repo = resolve(import.meta.dirname, "..", "..");
const tracked = { brain: "mac", kbDir: "tracked-kb", machines: [{ name: "mac", os: "darwin", agent: { host: "192.168.1.35", port: 7437 } }, { name: "windows", os: "win32", agent: { host: "192.168.1.34", port: 7437 } }] };
const savedHome = process.env.VLAD_HOME, savedKb = process.env.VLAD_KB_DIR; // makeHome VLAD_HOME'u değiştirir
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterEach(() => { restore("VLAD_HOME", savedHome); restore("VLAD_KB_DIR", savedKb); });

describe("S13: overlay (null = sil, sığ birleşim)", () => {
  it("machines:null + brain:null tracked machines/brain'i siler; checkMachines hata vermez", () => {
    const home = makeHome();
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify(tracked));
    writeFileSync(join(home, LOCAL_CONFIG_FILE), JSON.stringify({ machines: null, brain: null }));
    const cfg = loadLayeredConfig(home);
    expect(cfg.machines).toBeUndefined();
    expect(cfg.brain).toBeUndefined();
    expect(cfg.kbDir).toBe("tracked-kb"); // dokunulmayan anahtar tracked'tan gelir
  });
  it("overlay olmadan aynı tracked config: machines+brain kalır", () => {
    const home = makeHome();
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify(tracked));
    expect(loadLayeredConfig(home).machines).toHaveLength(2);
  });
  it("kbDir overlay'i üç okuyucuya yansır: loadLayeredConfig, resolveKbDir, forward.workerState", () => {
    const home = makeHome();
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify(tracked));
    writeFileSync(join(home, LOCAL_CONFIG_FILE), JSON.stringify({ machines: null, brain: null, kbDir: "overlay-kb" }));
    expect(loadLayeredConfig(home).kbDir).toBe("overlay-kb");
    expect(resolveKbDir(home).dir).toBe(resolve(home, "overlay-kb"));
    expect(loadConfig(home).kbDir).toBe("overlay-kb"); // loadConfig de overlay'li (tek ortak okuyucu)
    expect(workerState().kind).toBe("off"); // machines silindi → tek makine davranışı (tracked tek başına "unknown" verirdi)
  });
  it("overlay geçersiz birleşim üretirse şemayla reddedilir (config okunamadı)", () => {
    const home = makeHome();
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify(tracked));
    writeFileSync(join(home, LOCAL_CONFIG_FILE), JSON.stringify({ brain: "yok-makine" }));
    expect(() => loadLayeredConfig(home)).toThrow();
  });
  it("bozuk overlay JSON'u sessizce yutulmaz", () => {
    const home = makeHome();
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify(tracked));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, LOCAL_CONFIG_FILE), "{ bozuk");
    expect(() => loadLayeredConfig(home)).toThrow(/vlad\.config\.local\.json/);
  });
});

describe("S12: overlay yokken sonuç bugünkü loadConfig ile derin eşit (kullanıcının kurulumu)", () => {
  it("gerçek tracked vlad.config.json kopyası", () => {
    const home = makeHome();
    writeFileSync(join(home, "vlad.config.json"), readFileSync(join(repo, "vlad.config.json"), "utf8"));
    expect(loadLayeredConfig(home)).toEqual(loadConfig(home));
  });
  it("config dosyası hiç yokken de eşit (varsayılanlar)", () => {
    const home = makeHome();
    expect(loadLayeredConfig(home)).toEqual(loadConfig(home));
  });
});
