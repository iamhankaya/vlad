import { spawn } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approverDir, authorizeReset, mintOpToken, mintToken, requireModeAuthority, usedDir } from "../../src/mode/token.js";
import { assertSecureDir } from "../../src/mode/secure-fs.js";
import { spawnVlad, isolatedEnv } from "../support/spawn-vlad.js";
import { dirFiles, makeWorld } from "./approver-harness.js";
import type { World } from "./approver-harness.js";
import { IS_WIN } from "../support/platform.js";

// approver-kabul: gerçek VMT2 entegrasyonu (KK3/KK4 token yarısı, "Gerçek VMT2 entegrasyonu", "rotate/uninstall/--reset/--disable" tekrar oynatma).
// Gizli dizin geçici; çocuk süreçler VLAD_TEST_SECRET_DIR ile (no-secret-shim) aynı geçici dizine bağlanır, gerçek ~/.vlad-secret'e dokunulmaz.
const NIGHT = ["mode", "night", "--until", "23:59"];
const OFF = ["mode", "off"];
let w: World;
beforeEach(async () => { w = await makeWorld(); });
afterEach(async () => { await w.dispose(); });
const child = (args: string[], token?: string) => spawnVlad({ args, cwd: w.vladHome, env: { VLAD_HOME: w.vladHome, VLAD_TEST_SECRET_DIR: w.secret, ...(token ? { VLAD_MODE_TOKEN: token } : {}) } });
const env = (t: string) => ({ VLAD_MODE_TOKEN: t });

describe("approver-kabul: VMT2 gerçek CLI ile", () => {
  it("`dist/cli.js mode night` gerçek VMT2 ile bir kez geçer; ikinci çağrı ve başka argv reddedilir", () => {
    const tok = mintOpToken(NIGHT, 60_000);
    const other = child(["mode", "night", "--until", "23:58"], tok);
    expect(other.status, "başka argv").toBe(1);
    expect(child(["mode", "status"]).stdout).not.toMatch(/gece modu etkin/);
    const ok = child(NIGHT, tok);
    expect(ok.status, ok.stderr).toBe(0);
    expect(child(["mode", "status"]).stdout).toMatch(/gece modu etkin/);
    const again = child(NIGHT, tok);
    expect(again.status, "ikinci kullanım").toBe(1);
    expect(dirFiles(usedDir())).toHaveLength(1);
  });

  it("belirteçsiz korunan işlem hâlâ reddedilir; VMT1 terminal yolu aynen çalışır (KK9)", () => {
    expect(child(OFF).status).toBe(1);
    const v1 = mintToken(60_000);
    expect(child(["mode", "off"], v1).status).toBe(0);
    expect(child(NIGHT, v1).status, "VMT1 her argv için geçer (60 sn'lik genel yol)").toBe(0);
  });

  it("aynı VMT2'yi 4 süreç aynı anda kullanır: tam bir başarı (`used/` wx yarışı)", async () => {
    const tok = mintOpToken(OFF, 60_000);
    const runs = Array.from({ length: 4 }, () => new Promise<number | null>((res) => {
      const c = spawn(process.execPath, [join(import.meta.dirname, "..", "..", "dist", "cli.js"), ...OFF], { cwd: w.vladHome, env: isolatedEnv({ VLAD_HOME: w.vladHome, VLAD_TEST_SECRET_DIR: w.secret, VLAD_MODE_TOKEN: tok }), stdio: "ignore" });
      c.on("close", res);
    }));
    const codes = await Promise.all(runs);
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(codes.filter((c) => c === 1)).toHaveLength(3);
  }, 30_000);
});

describe("approver-kabul: VMT2 token kuralları (süreç içi)", () => {
  it("süre: 60 sn içinde geçer; 60 sn sonra geçmez (KK4)", () => {
    const t0 = new Date();
    const ok = mintOpToken(NIGHT, 60_000, t0);
    expect(() => requireModeAuthority(env(ok), new Date(t0.getTime() + 59_000), NIGHT)).not.toThrow();
    const late = mintOpToken(NIGHT, 60_000, t0);
    expect(() => requireModeAuthority(env(late), new Date(t0.getTime() + 61_000), NIGHT)).toThrow();
  });

  it("argv bağı: sıra, değer ve Unicode farkı reddedilir; aynı dizi geçer", () => {
    const a = ["mode", "night", "--until", "23:00", "--note", "ş"];
    const cases: string[][] = [["mode", "night", "--note", "ş", "--until", "23:00"], ["mode", "night", "--until", "23:00", "--note", "s"], ["mode", "night", "--until", "23:00", "--note", "ş", "--push"], ["mode", "night", "--until", "23:00"]];
    for (const c of cases) expect(() => requireModeAuthority(env(mintOpToken(a, 60_000)), new Date(), c), c.join(" ")).toThrow();
    expect(() => requireModeAuthority(env(mintOpToken(a, 60_000)), new Date(), a)).not.toThrow();
  });

  it("imza argv özetine bağlı: özet kısmı başka argv'ninkiyle değiştirilirse geçmez", () => {
    const t = mintOpToken(NIGHT, 60_000).split(".");
    const o = mintOpToken(OFF, 60_000).split(".");
    const forged = [t[0], t[1], t[2], o[3], t[4]].join(".");
    expect(() => requireModeAuthority(env(forged), new Date(), OFF)).toThrow();
    expect(() => requireModeAuthority(env(forged), new Date(), NIGHT)).toThrow();
  });

  it("biçim: exp NaN/negatif/taşma, kırpılmış parça, VMT1/VMT2 önek karışması reddedilir", () => {
    const [, exp, nonce, sha, mac] = mintOpToken(OFF, 60_000).split(".");
    const bad = [
      `VMT2.NaN.${nonce}.${sha}.${mac}`, `VMT2.-5.${nonce}.${sha}.${mac}`, `VMT2.${"9".repeat(40)}.${nonce}.${sha}.${mac}`, `VMT2.${exp}.${nonce}.${sha}`,
      `VMT2.${exp}.${nonce.slice(2)}.${sha}.${mac}`, `VMT1.${exp}.${mac}`, `VMT2.${exp}.${mac}`, `vmt2.${exp}.${nonce}.${sha}.${mac}`,
    ];
    for (const b of bad) expect(() => requireModeAuthority(env(b), new Date(), OFF), b).toThrow();
    const v1 = mintToken(60_000);
    expect(() => requireModeAuthority(env(v1), new Date(), OFF)).not.toThrow(); // VMT1 argv'den bağımsız
    expect(() => requireModeAuthority(env(v1.replace("VMT1", "VMT2")), new Date(), OFF)).toThrow();
  });

  it("process.env'deki token doğrulamadan sonra silinir (torun süreçlere miras kalmaz)", () => {
    process.env.VLAD_MODE_TOKEN = mintOpToken(OFF, 60_000);
    try {
      requireModeAuthority(process.env, new Date(), OFF);
      expect(process.env.VLAD_MODE_TOKEN).toBeUndefined();
    } finally { delete process.env.VLAD_MODE_TOKEN; }
  });

  // Windows'ta atlanır: chmod 0500 ile yazılamaz dizin POSIX'e özgü; Windows'ta mod biti yazmayı engellemez
  it.skipIf(IS_WIN)("`used/` yazılamıyorsa fail-closed (geçerli token bile geçmez); kök kullanıcıda skip değil açık hata", () => {
    if (process.getuid?.() === 0) throw new Error("kök kullanıcıda izin testi anlamsız: testler kök olmayan kullanıcıyla koşmalı");
    assertSecureDir(usedDir());
    expect(() => requireModeAuthority(env(mintOpToken(OFF, 60_000)), new Date(), OFF), "kontrol: yazılabilirken geçer").not.toThrow();
    chmodSync(usedDir(), 0o500);
    try { expect(() => requireModeAuthority(env(mintOpToken(OFF, 60_000)), new Date(), OFF)).toThrow(); }
    finally { chmodSync(usedDir(), 0o700); }
  });

  it("`mode token --reset` yetkisi VMT2 kabul etmez (argv uyuşmaz)", async () => {
    const t = mintOpToken(["mode", "token", "--reset"], 60_000);
    await expect(authorizeReset(env(t), new Date(), async () => "")).rejects.toThrow();
  });

  it("tüketim kayıtları yaşam döngüsünden bağımsız: approver/ silinse (uninstall) ve anahtar yenilense bile tekrar oynatma reddedilir", async () => {
    const tok = mintOpToken(OFF, 60_000);
    expect(() => requireModeAuthority(env(tok), new Date(), OFF)).not.toThrow();
    rmSync(approverDir(), { recursive: true, force: true }); // uninstall: approver/ altını siler; used/ ve mode.key kalır
    expect(dirFiles(usedDir())).toHaveLength(1);
    expect(() => requireModeAuthority(env(tok), new Date(), OFF), "uninstall sonrası tekrar").toThrow();
    const { initKey } = await import("../../src/mode/token.js");
    initKey(true); // --reset: yeni anahtar, eski belirteçler HMAC ile geçersiz
    expect(() => requireModeAuthority(env(mintOpToken(OFF, 60_000)), new Date(), OFF)).not.toThrow();
    expect(() => requireModeAuthority(env(tok), new Date(), OFF), "reset sonrası eski token").toThrow();
  });

  it("süresi dolmuş kayıt tembelce budanır; eski token gerçek saatle yine reddedilir (saat geri alma kapsam dışı)", () => {
    const t0 = new Date(Date.now() - 3_600_000);
    const old = mintOpToken(OFF, 60_000, t0);
    expect(() => requireModeAuthority(env(old), new Date(t0.getTime() + 1000), OFF)).not.toThrow(); // o günün saatiyle tüketildi
    requireModeAuthority(env(mintOpToken(OFF, 60_000)), new Date(), OFF); // yeni tüketim budamayı tetikler
    expect(() => requireModeAuthority(env(old), new Date(), OFF), "süresi doldu").toThrow();
  });

  it("budama süresi dolmamış kaydı silmez: yeni tüketilen token, başka bir tüketimden sonra da tekrar oynatılamaz", () => {
    const first = mintOpToken(OFF, 60_000);
    expect(() => requireModeAuthority(env(first), new Date(), OFF)).not.toThrow();
    requireModeAuthority(env(mintOpToken(NIGHT, 60_000)), new Date(), NIGHT); // budama tetiklenir
    expect(() => requireModeAuthority(env(first), new Date(), OFF), "tekrar oynatma").toThrow();
    expect(dirFiles(usedDir()).length).toBeGreaterThanOrEqual(2);
  });

});
