import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initKey, mintToken, secretDir, seamSecretDir, setSecretDirForTests } from "../../src/mode/token.js";
import { makeHome } from "../helpers.js";
import { spawnVlad } from "../support/spawn-vlad.js";

// F-vlad-337: alt süreç testleri gerçek gizli dizini görmesin; yalıtım yalnız tmp altında geçerli, üretimde korumayı aşamaz.
let root: string, home: string, sdir: string, kbHome: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-seam-"))); home = join(root, "home"); mkdirSync(home); sdir = join(root, "s"); kbHome = makeHome(); });
afterEach(() => { setSecretDirForTests(null); rmSync(root, { recursive: true, force: true }); });

describe("seamSecretDir (yalnız test yalıtımı)", () => {
  it("HOME ve gizli dizin geçici dizin altındaysa kabul edilir", () => {
    expect(seamSecretDir({ VLAD_TEST_SECRET_DIR: sdir }, home, tmpdir())).toBe(sdir);
  });
  it("değişken yoksa null", () => { expect(seamSecretDir({}, home, tmpdir())).toBeNull(); });
  it("HOME gerçek (geçici dizin dışı) ise yok sayılır: çalışan gerçek makinede mekanizmayı kapatamaz", () => {
    expect(seamSecretDir({ VLAD_TEST_SECRET_DIR: sdir }, "/Users/someone", tmpdir())).toBeNull();
  });
  it("gizli dizin geçici dizin dışındaysa yok sayılır", () => {
    expect(seamSecretDir({ VLAD_TEST_SECRET_DIR: "/Users/someone/gizli" }, home, tmpdir())).toBeNull();
  });
  it("'..' ve geçici dizinden dışarı sembolik bağ ile kaçış yok sayılır", () => {
    expect(seamSecretDir({ VLAD_TEST_SECRET_DIR: join(root, "..", "..", "x") }, home, tmpdir())).toBeNull();
    const link = join(root, "link"); symlinkSync("/Users", link);
    expect(seamSecretDir({ VLAD_TEST_SECRET_DIR: join(link, "me", "gizli") }, home, tmpdir())).toBeNull();
    const hl = join(root, "hl"); symlinkSync("/Users", hl);
    expect(seamSecretDir({ VLAD_TEST_SECRET_DIR: sdir }, hl, tmpdir())).toBeNull();
  });
  it("göreli yol kabul edilmez", () => { expect(seamSecretDir({ VLAD_TEST_SECRET_DIR: "rel/s" }, home, tmpdir())).toBeNull(); });
  it("secretDir: gerçek HOME'lu süreçte ortam seam'i etkisiz", () => {
    // test süreci gerçek HOME'da koşar (setup-cleanup'ın süreç içi yalıtımı kapalıyken bile seam gerçek dizini değiştiremez)
    const prev = process.env.VLAD_TEST_SECRET_DIR;
    process.env.VLAD_TEST_SECRET_DIR = sdir;
    setSecretDirForTests(null);
    try { expect(secretDir()).not.toBe(sdir); } finally { if (prev === undefined) delete process.env.VLAD_TEST_SECRET_DIR; else process.env.VLAD_TEST_SECRET_DIR = prev; }
  });
});

describe("alt süreç: etkin makine taklidi (anahtar var, belirteç şart)", () => {
  const run = (args: string[], env: Record<string, string>) => spawnVlad({ args, cwd: kbHome, env: { VLAD_HOME: kbHome, VLAD_TEST_SECRET_DIR: sdir, HOME: home, USERPROFILE: home, ...env } });
  it("seam dizininde anahtar varken belirteçsiz mode night reddedilir, geçerli belirteçle geçer", () => {
    setSecretDirForTests(sdir); initKey(); const token = mintToken(3_600_000); setSecretDirForTests(null);
    const bad = run(["mode", "night", "--until", "23:59"], {});
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/VLAD_MODE_TOKEN/);
    expect(run(["mode", "night", "--until", "23:59"], { VLAD_MODE_TOKEN: token }).status).toBe(0);
  });
  it("seam dizini yokken (varsayılan test ortamı) korunan işlem belirteçsiz geçer", () => {
    expect(run(["mode", "off"], {}).status).toBe(0);
  });
});
