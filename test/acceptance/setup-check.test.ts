// Kabul (T20261110-04; spec T20261110-02): `vlad setup --check` sözleşmesi (çıkış kodu 0/1/2, --json şeması, eksik parça raporu, sır sızmaması),
// plugin/izin parçaları, --answers kullanım hataları. Uygulama (T20261110-05) gelene dek KIRMIZI olması beklenir.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { PART_IDS } from "../../src/setup/index.js";
import { SECRET_RE, makeSandbox, repoRoot, s1Answers } from "../support/setup-sandbox.js";

const schema = JSON.parse(readFileSync(join(repoRoot, "schemas", "setup-check.schema.json"), "utf8"));
const validateSchema = new Ajv({ strict: false }).compile(schema);
const part = (j: any, id: string) => j.parts.find((p: any) => p.part === id);

describe("--check: temiz HOME'da eksik parça raporu", () => {
  const sb = makeSandbox({ platform: "darwin" });
  const c = sb.run(["setup", "--check", "--json"]);
  const j = JSON.parse(c.out || "{}");
  it("çıkış 1; çıktı setup-check şemasına uyar", () => {
    expect(c.code, c.err).toBe(1);
    expect(validateSchema(j), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(j).toMatchObject({ version: 1, platform: "darwin", ok: false, exit: 1 });
  });
  it("her parça bir kez raporlanır (PART_IDS kümesi)", () => {
    expect(j.parts.map((p: any) => p.part).sort()).toEqual([...PART_IDS].sort());
  });
  it("eksik parçalar adıyla + düzeltme komutuyla: hooks, global-skills, config, kb", () => {
    for (const id of ["hooks", "global-skills", "config", "kb"]) {
      const p = part(j, id);
      expect(p.status, id).toMatch(/eksik/);
      expect(p.severity, id).toBe("error");
      expect(p.fix, id).toBeTruthy();
    }
    expect(part(j, "tools").status).toBe("ok"); // sahte node/git/claude/tmux PATH'te
  });
  it("salt okuma: --check HOME/Claude dizinine hiçbir şey yazmaz", () => {
    const again = makeSandbox({ platform: "darwin" });
    const r = again.run(["setup", "--check"]);
    expect([0, 1], r.err).toContain(r.code); // komut çalışır (1 = eksik parça), yazmaz
    expect(r.out).not.toBe("");
    expect(again.calls()).toEqual([]);
    expect(() => readFileSync(join(again.claudeDir, "settings.json"))).toThrow();
  });
  it("insan okur çıktı (json'suz) de parça adlarını ve çıkış kodunu verir", () => {
    const h = sb.run(["setup", "--check"]);
    expect(h.code).toBe(1);
    for (const id of ["hooks", "kb"]) expect(h.out).toContain(id);
  });
  it("--only yalnız seçilen parçayı raporlar", () => {
    const r = sb.run(["setup", "--check", "--json", "--only", "hooks,kb"]);
    expect(JSON.parse(r.out).parts.map((p: any) => p.part).sort()).toEqual(["hooks", "kb"]);
  });
});

describe("--check: kurulum sonrası uyarılar (--strict) ve plugin/izin parçaları", () => {
  const sb = makeSandbox({ platform: "darwin" });
  const setup = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb))]);
  it("kurulum başarılı; izin kalıpları ve plugin'ler uyarı (warn) düzeyinde eksik", () => {
    expect(setup.code, setup.err + setup.out).toBe(0);
    const j = JSON.parse(sb.run(["setup", "--check", "--json"]).out);
    for (const id of ["permissions", "plugins"]) {
      expect(part(j, id).status, id).toBe("eksik");
      expect(part(j, id).severity, id).toBe("warn");
    }
    expect(part(j, "plugins").fix + part(j, "plugins").evidence).toMatch(/superpowers/);
  });
  it("--strict uyarıyı hataya çevirir (çıkış 1), normalde 0", () => {
    expect(sb.run(["setup", "--check"]).code).toBe(0);
    expect(sb.run(["setup", "--check", "--strict"]).code).toBe(1);
  });
  it("--check çıktısında anahtar/sır yok", () => {
    expect(SECRET_RE.test(setup.out + setup.err + sb.run(["setup", "--check", "--json"]).out)).toBe(false);
  });
});

describe("plugins: seçilen plugin enabledPlugins'e birleşir, kullanıcınınki silinmez", () => {
  it("plugins:[superpowers] → enabledPlugins; var olan anahtar korunur", () => {
    const sb = makeSandbox({ platform: "darwin" });
    sb.writeSettings({ enabledPlugins: { "baska@market": true } });
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb, { plugins: ["superpowers"] }))]);
    expect(r.code, r.err + r.out).toBe(0);
    const ep = sb.settings().enabledPlugins;
    expect(ep["baska@market"]).toBe(true);
    expect(Object.keys(ep).some((k) => k.startsWith("superpowers"))).toBe(true);
  });
});

describe("--answers kullanım hataları", () => {
  const sb = makeSandbox({ platform: "darwin" });
  it("etkileşimsizde --answers yok → çıkış 2, eksik sorular listelenir", () => {
    const r = sb.run(["setup", "--yes"], { input: "" });
    expect(r.code).toBe(2);
    expect(r.err + r.out).toMatch(/role|kb/);
  });
  it("bilinmeyen anahtar → çıkış 2, anahtar adıyla; hiçbir şey yazılmaz", () => {
    const r = sb.run(["setup", "--yes", "--answers", sb.answers({ ...s1Answers(sb), rol: "x" })]);
    expect(r.code).toBe(2);
    expect(r.err + r.out).toContain("rol");
  });
  it("keys alanına anahtar DEĞERİ konursa reddedilir ve değer çıktıya basılmaz", () => {
    const secret = "ab".repeat(32);
    const r = sb.run(["setup", "--yes", "--answers", sb.answers({ ...s1Answers(sb), keys: secret })]);
    expect(r.code).toBe(2);
    expect((r.err + r.out).includes(secret)).toBe(false);
  });
  it("bilinmeyen confirm eylemi reddedilir", () => {
    const r = sb.run(["setup", "--yes", "--answers", sb.answers({ ...s1Answers(sb), confirm: ["rm-rf"] })]);
    expect(r.code).toBe(2);
  });
  it("--answers - stdin'den JSON okur", () => {
    const sb2 = makeSandbox({ platform: "darwin" });
    const r = sb2.run(["setup", "--yes", "--answers", "-"], { input: sb2.answers(s1Answers(sb2)) });
    expect(r.code, r.err + r.out).toBe(0);
  });
});
