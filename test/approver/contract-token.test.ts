import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approverDir, initKey, mintOpToken, mintToken, requireModeAuthority, requireTtyOrApprovedOp, secretDir, setSecretDirForTests, usedDir } from "../../src/mode/token.js";

// approver sözleşmesi: token.ts imzaları (VMT2 gövdesi U1'de). VMT1 davranışı test/mode/mode-token.test.ts'te aynen kalır.
let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-ctok-"))); setSecretDirForTests(join(base, "s")); });
afterEach(() => { setSecretDirForTests(null); if (base.startsWith(realpathSync(tmpdir()))) { rmSync(base, { recursive: true, force: true }); } });

describe("approver sözleşmesi: token.ts", () => {
  it("approverDir/usedDir secretDir() altındadır ve ayrıdır (used/ approver/ dışında: yaşam döngüsü silmez)", () => {
    expect(approverDir()).toBe(join(secretDir(), "approver"));
    expect(usedDir()).toBe(join(secretDir(), "used"));
    expect(approverDir()).not.toBe(usedDir());
  });
  it("mintOpToken ttl sınırı: <=0, >120_000 ve NaN 'ttl geçersiz' (anahtardan önce denetlenir)", () => {
    for (const t of [0, -1, 120_001, NaN]) expect(() => mintOpToken(["mode", "off"], t), String(t)).toThrow("ttl geçersiz");
  });
  it("requireModeAuthority(env, now, argv): VMT1 yolu argv'den bağımsız, süre denetimi aynen", () => {
    initKey();
    const tok = mintToken(60_000);
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: tok }, new Date(), ["bambaşka", "argv"])).not.toThrow();
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: tok }, new Date(Date.now() + 120_000), ["x"])).toThrow(/süresi doldu/);
  });
  it("mintOpToken VMT2 biçimini üretir", () => {
    initKey();
    expect(mintOpToken(["mode", "off"], 60_000)).toMatch(/^VMT2\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}\.[0-9a-f]{64}$/);
  });
});

describe("requireTtyOrApprovedOp: TTY yoksa yalnız onaylı (VMT2, argv bağlı, tek kullanımlık) uzaktan işlem geçer", () => {
  const argv = ["monitor", "install"];
  it("TTY var: eski davranış (anahtar etkinse geçerli token şart)", () => {
    initKey();
    expect(() => requireTtyOrApprovedOp(true, {}, new Date(), argv)).toThrow(/VLAD_MODE_TOKEN/);
    expect(() => requireTtyOrApprovedOp(true, { VLAD_MODE_TOKEN: mintToken(60_000) }, new Date(), argv)).not.toThrow();
  });
  it("TTY yok + geçerli VMT2 (bu argv): geçer; ikinci kullanım reddedilir", () => {
    initKey();
    const env = { VLAD_MODE_TOKEN: mintOpToken(argv, 60_000) };
    expect(() => requireTtyOrApprovedOp(false, env, new Date(), argv)).not.toThrow();
    expect(() => requireTtyOrApprovedOp(false, env, new Date(), argv)).toThrow(/zaten kullanıldı/);
  });
  it("TTY yok + başka argv için VMT2, VMT1, token yok ya da sahte token: TTY hatası/ret", () => {
    initKey();
    expect(() => requireTtyOrApprovedOp(false, { VLAD_MODE_TOKEN: mintOpToken(["mode", "off"], 60_000) }, new Date(), argv)).toThrow(/argv uyuşmuyor/);
    expect(() => requireTtyOrApprovedOp(false, { VLAD_MODE_TOKEN: mintToken(60_000) }, new Date(), argv)).toThrow(/TTY/);
    expect(() => requireTtyOrApprovedOp(false, {}, new Date(), argv)).toThrow(/TTY/);
    expect(() => requireTtyOrApprovedOp(false, { VLAD_MODE_TOKEN: "VMT2.1.2.3.4" }, new Date(), argv)).toThrow(/geçersiz/);
  });
  it("anahtar etkin değilken sahte VMT2 TTY'yi atlatmaz", () => {
    expect(() => requireTtyOrApprovedOp(false, { VLAD_MODE_TOKEN: "VMT2." + "1".repeat(10) }, new Date(), argv)).toThrow(/TTY/);
  });
});
