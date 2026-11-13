import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initKey, mintToken, setSecretDirForTests } from "../../src/mode/token.js";
import { makeHome } from "../helpers.js";
import { spawnGuarded, spawnVlad } from "../support/spawn-vlad.js";

// F-vlad-337: alt süreç testleri gerçek gizli dizini görmesin; yalıtım yalnız tmp altında geçerli, üretimde korumayı aşamaz.
let root: string, home: string, sdir: string, kbHome: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-seam-"))); home = join(root, "home"); mkdirSync(home); sdir = join(root, "s"); kbHome = makeHome(); });
afterEach(() => { setSecretDirForTests(null); rmSync(root, { recursive: true, force: true }); });

describe("üretim dist'inde env ile açılan seam yok", () => {
  it("VLAD_TEST_SECRET_DIR/TMPDIR/HOME ile saldırı: shim yokken gizli dizin yine passwd ev dizini", () => {
    const r = spawnGuarded(process.execPath, ["-e", `import("${pathToFileURL(join(import.meta.dirname, "..", "..", "dist", "mode", "token.js")).href}").then(m => console.log(m.secretDir()))`],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home, VLAD_TEST_SECRET_DIR: sdir, NODE_OPTIONS: "" } });
    expect(r.stdout.trim()).not.toBe(sdir);
    expect(r.stdout.trim()).not.toContain(home);
  });
  it("shim yalnız test yardımcısında; dist/src içinde VLAD_TEST_SECRET_DIR okunmaz", () => {
    expect(readFileSync(join(import.meta.dirname, "..", "..", "src", "mode", "token.ts"), "utf8")).not.toMatch(/VLAD_TEST_SECRET_DIR|TMPDIR|tmpdir/);
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
  it("shim varsayılanı (VLAD_TEST_SECRET_DIR yok): korunan işlem belirteçsiz geçer, gerçek gizli dizin görülmez", () => {
    expect(spawnVlad({ args: ["mode", "off"], cwd: kbHome, env: { VLAD_HOME: kbHome, HOME: home, USERPROFILE: home } }).status).toBe(0);
  });
});
