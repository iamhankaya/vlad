import { createHash } from "node:crypto";
import {
  RemoteError, SCRIPT_FILE_RE, SCRIPT_LIMITS, SCRIPT_NAME_RE, SCRIPT_PARAM_TYPES,
  type ScriptClass, type ScriptEntry, type ScriptManifest, type ScriptParamSpec, type ScriptPlatform,
} from "../../fleet/types.js";
import { canonicalJson } from "../sign.js";

const PLATFORMS: readonly ScriptPlatform[] = ["win32", "darwin", "linux"];
const CLASSES: readonly ScriptClass[] = ["read", "write"];
const PARAM_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/; // `-`→`_` eşlemesi birebir (ad `_` içermez), VLAD_PARAM_<AD> çakışmaz
const SHA_RE = /^[0-9a-f]{64}$/;
const DEFAULT_STRING_RE = /^[A-Za-z0-9._-]+$/;
const ENTRY_KEYS = ["name", "title", "platform", "file", "sha256", "class", "timeoutSec", "outputMaxKb", "selfUpdate", "params"];
const PARAM_KEYS: Record<string, readonly string[]> = {
  string: ["name", "type", "required", "default", "pattern", "maxLen"], enum: ["name", "type", "required", "default", "values"],
  int: ["name", "type", "required", "default", "min", "max"], bool: ["name", "type", "required", "default"], root: ["name", "type", "required", "default"],
};
const PATTERN_MAX = 128; // shortcut: desen uzunluğu sınırlı, iç içe niceleyici taraması yok; manifest incelenmiş repo kodu

const badManifest = (m: string) => new RemoteError("failed", `failed: [bad_manifest] ${m}`);
const badParam = (name: string, why: string) => new RemoteError("bad_request", `bad_request: [bad_param:${name}] ${why}`);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const noCtl = (s: string) => !/[\0\r\n]/.test(s);

/** Tam eşleşmeli desen; geçersizse null. */
const fullRe = (p: string): RegExp | null => { try { return new RegExp(`^(?:${p})$`); } catch { return null; } };

function checkParam(p: unknown, at: string): ScriptParamSpec {
  if (!isObj(p)) throw badManifest(`${at}: param nesne olmalı`);
  const type = p.type;
  if (typeof type !== "string" || !(SCRIPT_PARAM_TYPES as readonly string[]).includes(type)) throw badManifest(`${at}: param tipi geçersiz`);
  const extra = Object.keys(p).filter((k) => !PARAM_KEYS[type]!.includes(k));
  if (extra.length) throw badManifest(`${at}: bilinmeyen param alanı: ${extra.join(", ")}`);
  if (typeof p.name !== "string" || !PARAM_NAME_RE.test(p.name)) throw badManifest(`${at}: param adı geçersiz`);
  if (p.required !== undefined && typeof p.required !== "boolean") throw badManifest(`${at}.${p.name}: required bool olmalı`);
  const w = `${at}.${p.name}`;
  if (type === "string") {
    if (p.pattern !== undefined && (typeof p.pattern !== "string" || p.pattern.length > PATTERN_MAX || !fullRe(p.pattern))) throw badManifest(`${w}: pattern geçersiz`);
    if (p.maxLen !== undefined && !isInt(p.maxLen, 1, SCRIPT_LIMITS.paramMaxLen)) throw badManifest(`${w}: maxLen 1..${SCRIPT_LIMITS.paramMaxLen}`);
  } else if (type === "enum") {
    if (!Array.isArray(p.values) || !p.values.length || !p.values.every((v) => typeof v === "string" && v && noCtl(v))) throw badManifest(`${w}: values boş olmayan dizge listesi olmalı`);
  } else if (type === "int") {
    for (const k of ["min", "max", "default"]) if (p[k] !== undefined && !(typeof p[k] === "number" && Number.isSafeInteger(p[k]))) throw badManifest(`${w}: ${k} tam sayı olmalı`);
    if (typeof p.min === "number" && typeof p.max === "number" && p.min > p.max) throw badManifest(`${w}: min > max`);
  }
  if (p.default !== undefined) {
    const t = type === "int" ? "number" : type === "bool" ? "boolean" : "string";
    if (typeof p.default !== t) throw badManifest(`${w}: default tipi uyumsuz`);
    // varsayılan, istemci değeriyle aynı kurallardan geçer (kendi kendine tutarlı manifest)
    try { checkValue(p as unknown as ScriptParamSpec, String(p.default)); } catch { throw badManifest(`${w}: default kendi kuralını sağlamıyor`); }
  }
  return p as unknown as ScriptParamSpec;
}

/**
 * `git show HEAD:agent-scripts/manifest.json` çıktısını (ayrıştırılmış JSON) doğrular. Şema ihlali ya da çift (name, platform)
 * → `RemoteError("failed", "failed: [bad_manifest] …")`; kısmi kabul yok.
 */
export function validateScriptManifest(raw: unknown): ScriptManifest {
  if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.scripts)) throw badManifest("kök {version:1, scripts:[…]} olmalı");
  const extraRoot = Object.keys(raw).filter((k) => k !== "version" && k !== "scripts");
  if (extraRoot.length) throw badManifest(`bilinmeyen kök alan: ${extraRoot.join(", ")}`);
  const seen = new Set<string>();
  for (const [i, e] of raw.scripts.entries()) {
    const at = `scripts[${i}]`;
    if (!isObj(e)) throw badManifest(`${at}: nesne olmalı`);
    const extra = Object.keys(e).filter((k) => !ENTRY_KEYS.includes(k));
    if (extra.length) throw badManifest(`${at}: bilinmeyen alan: ${extra.join(", ")}`);
    if (typeof e.name !== "string" || !SCRIPT_NAME_RE.test(e.name)) throw badManifest(`${at}: ad geçersiz`);
    if (typeof e.title !== "string" || !e.title || e.title.length > 120 || !noCtl(e.title)) throw badManifest(`${at}: title geçersiz`);
    if (typeof e.platform !== "string" || !(PLATFORMS as readonly string[]).includes(e.platform)) throw badManifest(`${at}: platform geçersiz`);
    if (typeof e.file !== "string" || !SCRIPT_FILE_RE.test(e.file)) throw badManifest(`${at}: file geçersiz`);
    if ((e.file.endsWith(".ps1")) !== (e.platform === "win32")) throw badManifest(`${at}: .ps1 yalnız win32, .sh yalnız darwin|linux`);
    if (typeof e.sha256 !== "string" || !SHA_RE.test(e.sha256)) throw badManifest(`${at}: sha256 64 küçük hex olmalı`);
    if (typeof e.class !== "string" || !(CLASSES as readonly string[]).includes(e.class)) throw badManifest(`${at}: class read|write olmalı`);
    if (!isInt(e.timeoutSec, 1, SCRIPT_LIMITS.timeoutSecMax)) throw badManifest(`${at}: timeoutSec 1..${SCRIPT_LIMITS.timeoutSecMax}`);
    if (!isInt(e.outputMaxKb, 1, SCRIPT_LIMITS.outputMaxKbMax)) throw badManifest(`${at}: outputMaxKb 1..${SCRIPT_LIMITS.outputMaxKbMax}`);
    if (typeof e.selfUpdate !== "boolean") throw badManifest(`${at}: selfUpdate bool olmalı`);
    if (!Array.isArray(e.params)) throw badManifest(`${at}: params dizi olmalı`);
    const names = new Set<string>();
    for (const p of e.params) {
      const s = checkParam(p, at);
      if (names.has(s.name)) throw badManifest(`${at}: kopya param adı: ${s.name}`);
      names.add(s.name);
    }
    const key = `${e.name}\0${e.platform}`;
    if (seen.has(key)) throw badManifest(`${at}: (ad, platform) kopya: ${e.name}/${e.platform}`);
    seen.add(key);
  }
  return raw as unknown as ScriptManifest;
}

/** Tek değeri parametre kurallarına göre denetler (root üyeliği Agent'ta, config'e bakarak ayrıca denetlenir). */
function checkValue(p: ScriptParamSpec, v: string): void {
  const no = (why: string): never => { throw badParam(p.name, why); };
  if (typeof v !== "string") return no("dizge olmalı");
  if (!noCtl(v)) return no("NUL/satır sonu yasak");
  if (p.type === "string") {
    const max = p.maxLen ?? SCRIPT_LIMITS.paramMaxLen;
    if (v.length > max) no(`en çok ${max} karakter`);
    if (p.pattern !== undefined) { if (!fullRe(p.pattern)!.test(v)) no("desene uymuyor"); }
    else if (!DEFAULT_STRING_RE.test(v) || v.startsWith("-") || v.includes("..")) no("izinli karakterler [A-Za-z0-9._-], baştaki '-' ve '..' yasak");
  } else if (p.type === "enum") {
    if (!p.values.includes(v)) no(`izinli değerler: ${p.values.join("|")}`);
  } else if (p.type === "int") {
    const n = Number(v);
    if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(n)) no("tam sayı olmalı");
    if (p.min !== undefined && n < p.min) no(`en az ${p.min}`);
    if (p.max !== undefined && n > p.max) no(`en çok ${p.max}`);
  } else if (p.type === "bool") {
    if (v !== "true" && v !== "false") no("true|false olmalı");
  } else if (!v || v.length > 1024) no("root adı geçersiz"); // root: üyelik Agent'ta
}

/**
 * İstemci değerlerini manifestteki kurallara göre doğrular ve `default`'ları uygular; hepsi dizge. Bilinmeyen anahtar, eksik
 * zorunlu, kural ihlali → `bad_request [bad_param:<ad>]`. CLI (plan-id) ve Agent aynı işlevi çağırır.
 */
export function normalizeParams(entry: ScriptEntry, given: Record<string, string>): Record<string, string> {
  if (!isObj(given)) throw badParam("params", "nesne olmalı");
  const known = new Map(entry.params.map((p) => [p.name, p]));
  for (const k of Object.keys(given)) if (!known.has(k)) throw badParam(k, "manifestte tanımlı değil");
  const out: Record<string, string> = {};
  for (const p of entry.params) {
    const v = Object.hasOwn(given, p.name) ? given[p.name] : p.default === undefined ? undefined : String(p.default);
    if (v === undefined) { if (p.required) throw badParam(p.name, "zorunlu"); continue; }
    checkValue(p, v as string);
    out[p.name] = v as string;
  }
  return out;
}

export interface ScriptPlanInput { machine: string; name: string; platform: ScriptPlatform; sha256: string; params: Record<string, string> }
/**
 * Write onayı için plan-id: `hex(sha256("VLAD-PLAN1\n"+machine+"\n"+name+"\n"+platform+"\n"+sha256+"\n"+canonicalJson(params)))[:16]`
 * (`canonicalJson`: agent/sign.ts). CLI (`--plan`) ve Agent (`approval.planId` denetimi) aynı işlevi kullanır.
 * `params`: istemcinin gönderdiği ham değerler, doğrulanmış ve manifest `default`'ları uygulanmış hâliyle; `root` değeri çözülmemiş ad olarak kalır.
 * `class`/`file`/`timeoutSec` hash'te yoktur: değişimleri `sha256` (betik) ve manifest satırı değişimiyle (incelemede görünür) yakalanır.
 */
export function scriptPlanId(i: ScriptPlanInput): string {
  const msg = `VLAD-PLAN1\n${i.machine}\n${i.name}\n${i.platform}\n${i.sha256}\n${canonicalJson(i.params)}`;
  return createHash("sha256").update(msg, "utf8").digest("hex").slice(0, 16);
}
