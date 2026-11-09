import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RemoteError, type ScriptEntry } from "../../src/fleet/types.js";
import { normalizeParams, scriptPlanId, validateScriptManifest } from "../../src/agent/scripts/manifest.js";

// Uygulama (T20261109-07): manifest doğrulama, parametre normalleştirme ve plan-id.

const H = "0".repeat(64);
const entry = (o: Partial<ScriptEntry> = {}): ScriptEntry => ({
  name: "repo-guncelle", title: "Repo güncelle", platform: "win32", file: "agent-scripts/repo-guncelle.ps1", sha256: H,
  class: "write", timeoutSec: 900, outputMaxKb: 32, selfUpdate: false, params: [], ...o,
});
const man = (...scripts: unknown[]) => ({ version: 1, scripts });
const bad = (raw: unknown) => { try { validateScriptManifest(raw); } catch (e) { return e as RemoteError; } throw new Error("fırlatmadı"); };

describe("validateScriptManifest", () => {
  it("geçerli manifesti aynen döner (win32 .ps1 ve darwin .sh aynı adla)", () => {
    const raw = man(entry(), entry({ platform: "darwin", file: "agent-scripts/repo-guncelle.sh" }));
    expect(validateScriptManifest(raw).scripts).toHaveLength(2);
  });
  it("her ihlal failed [bad_manifest] (kısmi kabul yok)", () => {
    const cases: [string, unknown][] = [
      ["version", { version: 2, scripts: [] }],
      ["kök dizi", []],
      ["scripts dizi değil", { version: 1, scripts: {} }],
      ["bilinmeyen alan", man({ ...entry(), extra: 1 })],
      ["kötü ad", man(entry({ name: "Rm Rf" }))],
      ["__proto__ adı", man(entry({ name: "__proto__" }))],
      ["kötü dosya yolu", man(entry({ file: "agent-scripts/sub/x.ps1" }))],
      ["ps1 + darwin", man(entry({ platform: "darwin" }))],
      ["sh + win32", man(entry({ file: "agent-scripts/x.sh" }))],
      ["kötü sha", man(entry({ sha256: "abc" }))],
      ["büyük harf sha", man(entry({ sha256: "A".repeat(64) }))],
      ["kötü sınıf", man(entry({ class: "admin" as never }))],
      ["timeout 0", man(entry({ timeoutSec: 0 }))],
      ["timeout > 3600", man(entry({ timeoutSec: 3601 }))],
      ["timeout kesirli", man(entry({ timeoutSec: 1.5 }))],
      ["outputMaxKb > 32", man(entry({ outputMaxKb: 33 }))],
      ["selfUpdate bool değil", man(entry({ selfUpdate: "evet" as never }))],
      ["çift (ad, platform)", man(entry(), entry())],
      ["kötü param tipi", man(entry({ params: [{ name: "x", type: "path" as never }] }))],
      ["kopya param adı", man(entry({ params: [{ name: "x", type: "bool" }, { name: "x", type: "bool" }] }))],
      ["büyük harfli param adı", man(entry({ params: [{ name: "X", type: "bool" }] }))],
      ["enum values yok", man(entry({ params: [{ name: "x", type: "enum" } as never] }))],
      ["geçersiz regex", man(entry({ params: [{ name: "x", type: "string", pattern: "(" }] }))],
      ["maxLen > 256", man(entry({ params: [{ name: "x", type: "string", maxLen: 257 }] }))],
      ["default enum dışı", man(entry({ params: [{ name: "x", type: "enum", values: ["a"], default: "b" }] }))],
      ["int min > max", man(entry({ params: [{ name: "x", type: "int", min: 5, max: 1 }] }))],
    ];
    for (const [why, raw] of cases) {
      const e = bad(raw);
      expect(e, why).toBeInstanceOf(RemoteError);
      expect(e.code, why).toBe("failed");
      expect(e.message, why).toMatch(/\[bad_manifest\]/);
    }
  });
});

describe("normalizeParams", () => {
  const spec = (params: ScriptEntry["params"]) => entry({ params });
  const err = (e: ScriptEntry, p: Record<string, string>) => { try { normalizeParams(e, p); } catch (x) { return x as RemoteError; } throw new Error("fırlatmadı"); };

  it("varsayılanları uygular ve hepsini dizgeye çevirir", () => {
    const e = spec([{ name: "n", type: "int", default: 5 }, { name: "b", type: "bool", default: false }, { name: "s", type: "string", required: false }]);
    expect(normalizeParams(e, {})).toEqual({ n: "5", b: "false" });
    expect(normalizeParams(e, { n: "7", s: "abc" })).toEqual({ n: "7", b: "false", s: "abc" });
  });
  it("ihlaller bad_request [bad_param:<ad>]", () => {
    const e = spec([
      { name: "req", type: "string", required: true },
      { name: "mode", type: "enum", values: ["a", "b"] },
      { name: "n", type: "int", min: 1, max: 9 },
      { name: "b", type: "bool" },
      { name: "pat", type: "string", pattern: "[a-z]+" },
    ]);
    const ok = { req: "x" };
    const cases: [string, Record<string, string>, string][] = [
      ["eksik zorunlu", {}, "req"],
      ["bilinmeyen anahtar", { ...ok, zzz: "1" }, "zzz"],
      ["enum dışı", { ...ok, mode: "c" }, "mode"],
      ["int değil", { ...ok, n: "1.5" }, "n"],
      ["int aralık dışı", { ...ok, n: "10" }, "n"],
      ["bool değil", { ...ok, b: "yes" }, "b"],
      ["regex tam eşleşme (kısmi değil)", { ...ok, pat: "ab1" }, "pat"],
      ["satır sonu", { ...ok, req: "a\nb" }, "req"],
      ["NUL", { ...ok, req: "a\0b" }, "req"],
      ["yol çıkışı", { ...ok, req: ".." }, "req"],
      ["baştaki tire", { ...ok, req: "-rf" }, "req"],
      ["çok uzun", { ...ok, req: "a".repeat(257) }, "req"],
      ["dizge değil", { ...ok, req: 5 as never }, "req"],
    ];
    for (const [why, p, name] of cases) {
      const x = err(e, p);
      expect(x.code, why).toBe("bad_request");
      expect(x.message, why).toContain(`[bad_param:${name}]`);
    }
  });
  it("__proto__ gibi anahtarlar nesne anahtarı olmaz", () => {
    const x = err(spec([]), JSON.parse('{"__proto__":"x"}'));
    expect(x.message).toContain("[bad_param:__proto__]");
  });
});

describe("scriptPlanId", () => {
  const base = { machine: "windows", name: "repo-guncelle", platform: "win32" as const, sha256: H, params: { root: "C:\\dev" } };
  it("16 hex, deterministik; anahtar sırasından bağımsız", () => {
    const id = scriptPlanId(base);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(scriptPlanId({ ...base, params: { b: "2", a: "1" } })).toBe(scriptPlanId({ ...base, params: { a: "1", b: "2" } }));
  });
  it("makine, ad, platform, betik sürümü ya da parametre değişince değişir", () => {
    const id = scriptPlanId(base);
    for (const o of [{ machine: "x" }, { name: "y" }, { platform: "darwin" as const }, { sha256: "1".repeat(64) }, { params: { root: "D:\\" } }]) {
      expect(scriptPlanId({ ...base, ...o }), JSON.stringify(o)).not.toBe(id);
    }
  });
  it("formül sözleşmedeki gibi (CLI ve Agent aynı kimliği üretmeli)", () => {
    const want = createHash("sha256").update(`VLAD-PLAN1\nm\nn\nwin32\n${H}\n{"a":"1","b":"2"}`, "utf8").digest("hex").slice(0, 16);
    expect(scriptPlanId({ machine: "m", name: "n", platform: "win32", sha256: H, params: { b: "2", a: "1" } })).toBe(want);
  });
});
