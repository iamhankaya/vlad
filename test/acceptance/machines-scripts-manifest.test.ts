// Kabul (T20261109-06, çatı T20261109-03): manifest doğrulaması, plan-id formülü ve repodaki gerçek manifest/betikler.
// Kaynak: spec raporu (T20261109-04) "Manifest şeması", "Write onay modeli", "repo-guncelle'nin manifeste girişi", KK1/KK3/KK6/KK7 + sözleşme (T20261109-05) tipleri.
// Uygulama (T20261109-07) yokken KIRMIZI beklenir: validateScriptManifest/scriptPlanId gövdesiz, agent-scripts/ yok.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/agent/sign.js";
import { scriptPlanId, validateScriptManifest } from "../../src/agent/scripts/manifest.js";
import { RemoteError, type ScriptEntry } from "../../src/fleet/types.js";

const root = join(import.meta.dirname, "..", "..");
const H = "0".repeat(64);
const entry = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "repo-guncelle", title: "Repo güncelle", platform: "win32", file: "agent-scripts/repo-guncelle.ps1", sha256: H,
  class: "write", timeoutSec: 900, outputMaxKb: 32, selfUpdate: false, params: [{ name: "root", type: "root", required: false }], ...o,
});
const manifest = (...scripts: Record<string, unknown>[]) => ({ version: 1, scripts });
const rejects = (raw: unknown, why = "") => {
  let e: unknown;
  try { validateScriptManifest(raw); } catch (x) { e = x; }
  expect(e, `reddedilmeli: ${why}`).toBeInstanceOf(RemoteError);
  expect((e as RemoteError).code, why).toBe("failed");
  expect((e as RemoteError).message, why).toMatch(/\[bad_manifest\]/);
};

describe("scripts K1: validateScriptManifest — geçerli manifest", () => {
  it("geçerli manifesti aynen döndürür; aynı ad iki platformda (win32 + darwin) tekil sayılır", () => {
    const raw = manifest(entry(), entry({ platform: "darwin", file: "agent-scripts/repo-guncelle.sh" }));
    const m = validateScriptManifest(raw);
    expect(m.version).toBe(1);
    expect(m.scripts.map((s) => `${s.name}/${s.platform}`)).toEqual(["repo-guncelle/win32", "repo-guncelle/darwin"]);
  });
  it("tüm parametre tipleri kabul edilir", () => {
    const params = [
      { name: "tag", type: "string", pattern: "^[a-z]+$", maxLen: 8, required: true },
      { name: "mode", type: "enum", values: ["a", "b"], default: "a" },
      { name: "n", type: "int", min: 1, max: 5, default: 2 },
      { name: "flag", type: "bool", default: false },
      { name: "root", type: "root" },
    ];
    expect(() => validateScriptManifest(manifest(entry({ params })))).not.toThrow();
  });
  it("boş betik listesi geçerli", () => { expect(validateScriptManifest(manifest()).scripts).toEqual([]); });
});

describe("scripts K1: validateScriptManifest — reddedilenler (failed [bad_manifest], kısmi kabul yok)", () => {
  const BAD: [string, unknown][] = [
    ["manifest nesne değil", "x"],
    ["manifest null", null],
    ["sürüm 2", { version: 2, scripts: [] }],
    ["sürüm yok", { scripts: [] }],
    ["scripts dizi değil", { version: 1, scripts: {} }],
    ["ad büyük harf", manifest(entry({ name: "Repo" }))],
    ["ad rakamla başlar", manifest(entry({ name: "1a" }))],
    ["ad 49 karakter", manifest(entry({ name: "a".repeat(49) }))],
    ["ad yol karakteri", manifest(entry({ name: "a/b" }))],
    ["ad __proto__", manifest(entry({ name: "__proto__" }))],
    ["çift (ad, platform)", manifest(entry(), entry())],
    ["dosya alt dizinde", manifest(entry({ file: "agent-scripts/sub/x.ps1" }))],
    ["dosya agent-scripts dışında", manifest(entry({ file: "../x.ps1" }))],
    ["dosya mutlak yol", manifest(entry({ file: "/etc/x.sh", platform: "darwin" }))],
    ["dosya uzantısı .js", manifest(entry({ file: "agent-scripts/x.js" }))],
    [".ps1 darwin'de", manifest(entry({ platform: "darwin" }))],
    [".ps1 linux'ta", manifest(entry({ platform: "linux" }))],
    [".sh win32'de", manifest(entry({ file: "agent-scripts/x.sh" }))],
    ["platform bilinmeyen", manifest(entry({ platform: "freebsd" }))],
    ["sha256 yok", manifest((() => { const e = entry(); delete e.sha256; return e; })())],
    ["sha256 63 hex", manifest(entry({ sha256: "a".repeat(63) }))],
    ["sha256 büyük harf", manifest(entry({ sha256: "A".repeat(64) }))],
    ["sha256 hex değil", manifest(entry({ sha256: "g".repeat(64) }))],
    ["sınıf bilinmeyen", manifest(entry({ class: "admin" }))],
    ["timeoutSec 0", manifest(entry({ timeoutSec: 0 }))],
    ["timeoutSec 3601", manifest(entry({ timeoutSec: 3601 }))],
    ["timeoutSec kesirli", manifest(entry({ timeoutSec: 1.5 }))],
    ["outputMaxKb 0", manifest(entry({ outputMaxKb: 0 }))],
    ["outputMaxKb 33 (donanımsal tavan 32)", manifest(entry({ outputMaxKb: 33 }))],
    ["selfUpdate bool değil", manifest(entry({ selfUpdate: "yes" }))],
    ["bilinmeyen giriş alanı (yorumlayıcı belirtme girişimi)", manifest(entry({ interpreter: "cmd.exe" }))],
    ["parametre tipi bilinmeyen", manifest(entry({ params: [{ name: "x", type: "path" }] }))],
    ["enum values yok", manifest(entry({ params: [{ name: "x", type: "enum" }] }))],
    ["string maxLen 257", manifest(entry({ params: [{ name: "x", type: "string", maxLen: 257 }] }))],
  ];
  it.each(BAD)("%s", (why, raw) => rejects(raw, why));

  it("iyi bir giriş kötü bir girişle birlikte: hiçbiri kabul edilmez (kısmi kabul yok)", () => {
    rejects(manifest(entry({ name: "iyi", file: "agent-scripts/iyi.ps1" }), entry({ name: "kotu", file: "agent-scripts/kotu.ps1", sha256: "zz" })), "iyi+kötü");
  });
});

describe("scripts K6: scriptPlanId — plan-id formülü (sözleşme: hex(sha256('VLAD-PLAN1\\n'+makine+'\\n'+ad+'\\n'+platform+'\\n'+sha256+'\\n'+canonicalJson(params)))[:16])", () => {
  const base = { machine: "windows", name: "repo-guncelle", platform: "win32" as const, sha256: H, params: { root: "C:\\dev" } };
  const expected = (i: typeof base) =>
    createHash("sha256").update(`VLAD-PLAN1\n${i.machine}\n${i.name}\n${i.platform}\n${i.sha256}\n${canonicalJson(i.params)}`, "utf8").digest("hex").slice(0, 16);
  it("spec formülüyle birebir, 16 küçük harf hex", () => {
    const id = scriptPlanId(base);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).toBe(expected(base));
  });
  it("boş parametrelerde de formüle uyar", () => {
    const i = { ...base, params: {} };
    expect(scriptPlanId(i)).toBe(expected(i));
  });
  it("deterministik; parametre anahtar sırasından bağımsız", () => {
    const a = scriptPlanId({ ...base, params: { a: "1", b: "2" } });
    expect(scriptPlanId({ ...base, params: { b: "2", a: "1" } })).toBe(a);
    expect(scriptPlanId({ ...base, params: { a: "1", b: "2" } })).toBe(a);
  });
  it.each([
    ["makine", { machine: "linux1" }],
    ["ad", { name: "vlad-guncelle" }],
    ["platform", { platform: "darwin" as const }],
    ["sha256 (betik değişti)", { sha256: "1".repeat(64) }],
    ["parametre değeri", { params: { root: "D:\\dev" } }],
    ["ek parametre", { params: { root: "C:\\dev", x: "1" } }],
  ])("%s değişince plan-id değişir (onay yalnız o sürüm + parametre için geçerli)", (_n, patch) => {
    expect(scriptPlanId({ ...base, ...patch })).not.toBe(scriptPlanId(base));
  });
});

describe("scripts K3/K7: repodaki gerçek manifest ve betikler (agent-scripts/)", () => {
  const dir = join(root, "agent-scripts");
  const raw = () => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  it("agent-scripts/manifest.json var ve şemaya uyar", () => {
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(() => validateScriptManifest(raw())).not.toThrow();
  });
  it("manifest 64 KiB altında", () => {
    expect(readFileSync(join(dir, "manifest.json")).length).toBeLessThanOrEqual(64 * 1024);
  });
  it("her giriş: dosyası var, sha256 dosya baytlarının özetiyle aynı (CI testi: elle güncellenmeyi unutma)", () => {
    for (const s of validateScriptManifest(raw()).scripts as ScriptEntry[]) {
      const f = join(root, s.file);
      expect(existsSync(f), s.file).toBe(true);
      expect(createHash("sha256").update(readFileSync(f)).digest("hex"), `${s.name}/${s.platform} sha256`).toBe(s.sha256);
    }
  });
  it("ilk betikler: repo-guncelle (win32 + darwin, write, root parametresi) ve vlad-guncelle (win32 + darwin, write, selfUpdate)", () => {
    const by = new Map((validateScriptManifest(raw()).scripts as ScriptEntry[]).map((s) => [`${s.name}/${s.platform}`, s]));
    for (const p of ["win32", "darwin"]) {
      const rg = by.get(`repo-guncelle/${p}`);
      expect(rg, `repo-guncelle/${p}`).toBeDefined();
      expect(rg!.class).toBe("write");
      expect(rg!.selfUpdate).toBe(false);
      expect(rg!.params.some((x) => x.name === "root" && x.type === "root")).toBe(true);
      const vg = by.get(`vlad-guncelle/${p}`);
      expect(vg, `vlad-guncelle/${p}`).toBeDefined();
      expect(vg!.class).toBe("write");
      expect(vg!.selfUpdate).toBe(true);
    }
  });
  it(".ps1 dosyaları ASCII ya da BOM'lu (PS 5.1 BOM'suz UTF-8'i ANSI okur)", () => {
    const ps = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".ps1")) : [];
    expect(ps.length).toBeGreaterThan(0);
    for (const n of ps) {
      const b = readFileSync(join(dir, n));
      const bom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
      expect(bom || b.every((x) => x < 0x80), `${n}: ASCII değil ve BOM yok`).toBe(true);
    }
  });
  it("betiklerde Invoke-Expression/iex/eval yok (parametre enjeksiyonu lint'i)", () => {
    const all = existsSync(dir) ? readdirSync(dir).filter((n) => /\.(ps1|sh)$/.test(n)) : [];
    expect(all.length).toBeGreaterThan(0);
    for (const n of all) {
      const t = readFileSync(join(dir, n), "utf8").split("\n").filter((l) => !/^\s*(#|<#)/.test(l)).join("\n");
      expect(t, n).not.toMatch(/\bInvoke-Expression\b|(^|[\s;|(])iex\b|(^|[\s;|(])eval\b/i);
    }
  });
  it(".gitignore dist-next/ ve dist-old/ satırlarını içerir (vlad-guncelle swap dizinleri)", () => {
    const g = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(g).toContain("dist-next/");
    expect(g).toContain("dist-old/");
  });
  it("docs/agent-scripts.md var; manifest, plan-id ve sonuç sentineli belgelenmiş", () => {
    const f = join(root, "docs", "agent-scripts.md");
    expect(existsSync(f)).toBe(true);
    const t = readFileSync(f, "utf8");
    for (const k of ["manifest.json", "plan-id", "@@VLAD-RESULT@@", "VLAD_PARAM_"]) expect(t, k).toContain(k);
  });
  it("docs/machines-agent-security.md yeni uzak betik yüzeyini anar (script-run)", () => {
    expect(readFileSync(join(root, "docs", "machines-agent-security.md"), "utf8")).toContain("script-run");
  });
});
