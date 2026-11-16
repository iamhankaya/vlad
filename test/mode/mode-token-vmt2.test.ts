import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "../../src/approver/types.js";
import { authorizeReset, initKey, mintOpToken, mintToken, requireModeAuthority, setSecretDirForTests, usedDir } from "../../src/mode/token.js";

let base: string;
const NOW = new Date(1_800_000_000_000);
const ARGV = ["mode", "off"];
const saved = process.env.VLAD_MODE_TOKEN;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-vmt2-"))); setSecretDirForTests(join(base, "s")); initKey(); });
afterEach(() => {
  setSecretDirForTests(null);
  if (saved === undefined) delete process.env.VLAD_MODE_TOKEN; else process.env.VLAD_MODE_TOKEN = saved;
  if (base.startsWith(realpathSync(tmpdir()))) rmSync(base, { recursive: true, force: true });
});
const use = (tok: string, argv = ARGV, now = NOW): void => requireModeAuthority({ VLAD_MODE_TOKEN: tok }, now, argv);

describe("vmt2: üretim ve doğrulama", () => {
  it("biçim; doğru argv ile bir kez geçer ve process.env.VLAD_MODE_TOKEN temizlenir", () => {
    const tok = mintOpToken(ARGV, 60_000, NOW);
    expect(tok).toMatch(/^VMT2\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}\.[0-9a-f]{64}$/);
    process.env.VLAD_MODE_TOKEN = tok;
    use(tok);
    expect(process.env.VLAD_MODE_TOKEN).toBeUndefined();
    expect(readdirSync(usedDir())).toHaveLength(1);
  });
  it("tek kullanım: ikinci kullanım reddedilir", () => {
    const tok = mintOpToken(ARGV, 60_000, NOW);
    use(tok);
    expect(() => use(tok)).toThrow(/zaten kullanıldı/);
  });
  it("argv bağı: sıra ve Unicode farkı reddedilir, reddedilen token yanmaz", () => {
    const tok = mintOpToken(["mode", "night", "--note", "çay"], 60_000, NOW);
    expect(() => use(tok, ["mode", "night", "--note", "cay"])).toThrow(/argv/);
    expect(() => use(tok, ["night", "mode", "--note", "çay"])).toThrow(/argv/);
    expect(existsSync(usedDir())).toBe(false);
    expect(() => use(tok, ["mode", "night", "--note", "çay"])).not.toThrow();
  });
  it("süre dolumu reddedilir (now parametresi)", () => {
    const tok = mintOpToken(ARGV, 60_000, NOW);
    expect(() => use(tok, ARGV, new Date(NOW.getTime() + 60_000))).toThrow(/süresi doldu/);
  });
  it("bozuk imza, biçim ve önek karışması reddedilir", () => {
    const tok = mintOpToken(ARGV, 60_000, NOW);
    expect(() => use(tok.slice(0, -1) + (tok.endsWith("0") ? "1" : "0"))).toThrow(/geçersiz/);
    expect(() => use(tok.replace("VMT2.", "VMT1."))).toThrow(/geçersiz/);
    const v1 = mintToken(60_000, NOW);
    expect(() => use(v1.replace("VMT1.", "VMT2."))).toThrow(/geçersiz/);
    const p = tok.split(".");
    for (const exp of ["NaN", "-5", "1".repeat(20), ""]) expect(() => use([p[0], exp, p[2], p[3], p[4]].join("."))).toThrow(/geçersiz/);
  });
  it("ttl sınırı LIMITS.maxTokenTtlMs ile eşit", () => {
    expect(LIMITS.maxTokenTtlMs).toBe(120_000);
    expect(() => mintOpToken(ARGV, LIMITS.maxTokenTtlMs, NOW)).not.toThrow();
    expect(() => mintOpToken(ARGV, LIMITS.maxTokenTtlMs + 1, NOW)).toThrow("ttl geçersiz");
  });
  it("used/ yazılamazsa fail-closed", () => {
    const tok = mintOpToken(ARGV, 60_000, NOW);
    writeFileSync(usedDir(), "dosya"); // dizin yerine dosya
    expect(() => use(tok)).toThrow(/fail-closed|yazılamadı/);
    rmSync(usedDir());
  });
  it("budama: exp+60sn geçmiş kayıtlar silinir, yenisi kalır", () => {
    const t1 = mintOpToken(ARGV, 10_000, NOW);
    use(t1);
    const later = new Date(NOW.getTime() + 10_000 + 60_001);
    const t2 = mintOpToken(ARGV, 60_000, later);
    expect(readdirSync(usedDir())).toHaveLength(0);
    use(t2, ARGV, later);
    expect(readdirSync(usedDir())).toHaveLength(1);
  });
  it("VMT1 regresyonu: argv'den bağımsız, tüketilmez", () => {
    const v1 = mintToken(60_000, NOW);
    use(v1, ["x"]); use(v1, ["y"]);
    expect(existsSync(usedDir())).toBe(false);
  });
  it("VMT2 `mode token --reset` yolunda kabul edilmez (argv uyuşmaz)", async () => {
    const tok = mintOpToken(["mode", "token"], 60_000, NOW);
    const argv = process.argv;
    process.argv = [argv[0]!, argv[1]!, "mode", "token", "--reset"];
    try { await expect(authorizeReset({ VLAD_MODE_TOKEN: tok }, NOW, async () => "")).rejects.toThrow(/argv/); } finally { process.argv = argv; }
  });
});
