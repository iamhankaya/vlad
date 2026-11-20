import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { CONFIRM_ACTIONS } from "../setup/types.js";
import { COMMANDS } from "../commands/manifest.js";
import { LIMITS, NOTE_MAX_BYTES, type ApprovalRequestFile, type Ctx, type DropReason, type Op, type PendingRecord, type RejectReason } from "./types.js";

/**
 * Saf doğrulama/özet/tag/bildirim fonksiyonları; rastgelelik `RandomSource` ile ayrı.
 * İmzalar T20261116-03 planıyla birebir. Golden: test/fixtures/approver/golden-*.json (uygulamadan bağımsız formül).
 */
export interface RandomSource { bytes(n: number): Buffer }

type Verdict = { ok: true; req: ApprovalRequestFile } | { ok: false; reason: RejectReason; detail: string };
type Bad = { reason: RejectReason; detail: string };
const no = (reason: RejectReason, detail: string): Verdict => ({ ok: false, reason, detail });
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Eski beş işlem: sıkı argüman şeması (aşağıda) korunur; diğer her manifest komutu genel yoldan (serbest argüman, boyut/kontrol sınırı) geçer. */
const LEGACY_OPS: readonly Op[] = ["mode night", "mode watch", "mode off", "install", "setup"];
/**
 * Korunan (VMT2 gerektiren) bilinçli izin kümesi, AÇIK liste: manifestte `console: none` olsalar da telefondan istenebilir ve yürütmede yalnız bunlara VMT2 verilir.
 * Engelli küme manifest türevidir (`isBlockedPath`): `console.kind === "none"` olan her yol + `remote` + `agent *`, bu liste hariç. Yeni `console: none` komut otomatik engellenir
 * (`mode request`/`mode token`/`approver run|install|uninstall|rotate|unlock`, `task close|release|repin`, `audit setup` … hepsi bu yoldan engelli).
 */
export const PROTECTED_OPS: readonly Op[] = ["mode night", "mode watch", "mode off", "install", "setup", "monitor install", "monitor uninstall"];
const isBlockedPath = (path: readonly string[]): boolean => {
  if (PROTECTED_OPS.includes(path.join(" "))) return false;
  if (path[0] === "remote" || path[0] === "agent") return true;
  return COMMANDS.some((c) => c.console.kind === "none" && c.path.length === path.length && c.path.every((t, i) => t === path[i]));
};
const COMMAND_PATHS: readonly (readonly string[])[] = COMMANDS.map((c) => c.path);
/** İstemci için: argv'nin işlemi (manifestteki en uzun komut yolu, boşlukla birleşik) ya da null. */
export const opOfArgv = (argv: string[]): string | null => commandPathOf(argv)?.join(" ") ?? null;
/** argv'nin manifestteki en uzun komut yolu öneki (yoksa null). */
function commandPathOf(argv: string[]): string[] | null {
  let best: readonly string[] | null = null;
  for (const p of COMMAND_PATHS) if (p.length <= argv.length && p.every((t, i) => argv[i] === t) && (!best || p.length > best.length)) best = p;
  return best ? [...best] : null;
}
const KEYS = ["v", "cid", "op", "argv", "requestedAt", "requester"];
/** İstemcinin yazabileceği ama servisin ASLA kullanmadığı alanlar (bildirim/nonce/id/konu/tag servisin kendi verisinden): yok sayılır. */
const IGNORED_KEYS = ["title", "message", "nonce", "id", "respTopic", "tag", "topic"];
// NUL/C0/C1, satır-paragraf ayracı, sıfır genişlik ve çift yönlü (bidi) biçim karakterleri
// Genel s\u0131n\u0131f: Cc/Cf/Zs/Zl/Zp (ASCII bo\u015fluk U+0020 hari\u00e7) + dolgu/varyasyon/birle\u015fik-g\u00f6r\u00fcnmez Mn karakterleri. Not: U+FE0F (emoji VS16) da reddedilir (belgelendi: docs/uzaktan-onay.md).
const CONTROL = /(?! )[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180d\u2800\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]/u;
const CID_RE = /^[a-z2-7]{26}$/;
const REQUESTER_RE = /^[\w.@:-]{1,64}$/;
const TASK_LIST = /^T\d{8}-\d+(,T\d{8}-\d+)*$/;
const SLUG_LIST = /^[a-z-]+(,[a-z-]+)*$/;
const PROJECT_LIST = /^\w[\w.-]*(,\w[\w.-]*)*$/; // `.`/`..`/noktayla başlayan ad yok (F-vlad-346)
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const UNINSTALL_PARTS = ["hooks", "global-skills", "config"];

type FlagSpec = { value: false } | { value: true; ok: (v: string) => boolean; empty?: boolean };
const bool: FlagSpec = { value: false };
const val = (ok: (v: string) => boolean, empty = false): FlagSpec => ({ value: true, ok, empty });

/** ARGV_SCHEMA: bayrak başına tür/arite/doğrulama. Dışındaki her şey (bilinmeyen bayrak, `--x=y`, `--`, pozisyonel) bad_flag. */
const ARGV_SCHEMA: Record<"mode night" | "install" | "setup --upgrade", Record<string, FlagSpec>> = {
  "mode night": {
    "--until": val((v) => HHMM.test(v) || (ISO.test(v) && !Number.isNaN(Date.parse(v)))),
    "--until-task": val((v) => TASK_LIST.test(v)), "--push": bool, "--except": val((v) => SLUG_LIST.test(v)),
    "--projects": val((v) => PROJECT_LIST.test(v)), "--note": val(() => true, true),
  },
  install: { "--remove-menu": bool },
  "setup --upgrade": {
    "--yes": bool, "--confirm": val((v) => SLUG_LIST.test(v) && v.split(",").every((c) => (CONFIRM_ACTIONS as readonly string[]).includes(c))),
  },
};

function parseFlags(argv: string[], from: number, spec: Record<string, FlagSpec>): Bad | null {
  const seen = new Set<string>();
  for (let i = from; i < argv.length; i++) {
    const t = argv[i]!, s = Object.hasOwn(spec, t) ? spec[t] : undefined;
    if (!s) return { reason: "bad_flag", detail: `izinsiz bayrak/argüman (konum ${i})` };
    if (seen.has(t)) return { reason: "duplicate_flag", detail: `tekrarlanan bayrak: ${t}` };
    seen.add(t);
    if (!s.value) continue;
    const v = argv[++i];
    if (v === undefined || (v === "" && !s.empty) || v.startsWith("-") || !s.ok(v)) return { reason: "bad_value", detail: `${t} için geçersiz değer` };
  }
  return null;
}

function checkSetup(argv: string[]): Bad | null {
  const rest = argv.slice(1);
  if (rest.includes("--answers")) return { reason: "setup_answers_unsupported", detail: "setup --answers uzaktan desteklenmez" };
  if (rest.includes("--dry-run")) return { reason: "bad_flag", detail: "--dry-run uzaktan istenemez" };
  const up = rest.includes("--upgrade"), un = rest.includes("--uninstall");
  if (up && un) return { reason: "conflicting", detail: "--upgrade ve --uninstall birlikte olamaz" };
  if (!up && !un) {
    return rest.length === 0 || ["--yes", "--only", "--confirm"].includes(rest[0]!)
      ? { reason: "setup_answers_unsupported", detail: "düz setup uzaktan desteklenmez (yalnız --upgrade / --uninstall <parça>)" }
      : { reason: "bad_flag", detail: "setup yalnız --upgrade ya da --uninstall <parça>" };
  }
  if (un) {
    if (rest[0] !== "--uninstall" || rest.length > 2) return { reason: "bad_flag", detail: "setup --uninstall yalnız tek parça alır" };
    return UNINSTALL_PARTS.includes(rest[1] ?? "") ? null : { reason: "bad_value", detail: `--uninstall parçası: ${UNINSTALL_PARTS.join("|")}` };
  }
  if (rest[0] !== "--upgrade") return { reason: "bad_flag", detail: "setup --upgrade ilk bayrak olmalı" };
  // --only reddedilir: runUpgrade parça seçimini uygulamaz (cli + global-skills + hooks hepsini yazar); dar kapsam göstermek yanıltıcı olurdu
  if (rest.includes("--only")) return { reason: "bad_flag", detail: "setup --only uzaktan desteklenmez (--upgrade cli + global skill'ler + hooks uygular)" };
  return parseFlags(argv, 2, ARGV_SCHEMA["setup --upgrade"]);
}

/** Allowlist/şema doğrulama (`ARGV_SCHEMA`): bayrak başına tür/arite/enum/boyut; boyut ölçüsü UTF-8 bayt (toplam ≤ LIMITS.maxArgvBytes, değer ≤ maxValueBytes). */
export function validateRequest(raw: unknown): Verdict {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return no("bad_value", "istek nesne değil");
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !KEYS.includes(k) && !IGNORED_KEYS.includes(k)) || KEYS.some((k) => !(k in r))) return no("bad_value", "alan kümesi beklenenden farklı");
  const { v, cid, op, argv, requestedAt, requester } = r;
  if (v !== 1 || typeof cid !== "string" || typeof op !== "string" || typeof requestedAt !== "string" || typeof requester !== "string" || !Array.isArray(argv) || argv.some((a) => typeof a !== "string"))
    return no("bad_value", "alan türleri geçersiz");
  const args = argv as string[];
  if (bytes(JSON.stringify(args)) > LIMITS.maxArgvBytes || args.some((a) => bytes(a) > LIMITS.maxValueBytes)) return no("too_large", "argv ya da bir değer boyut sınırını aşıyor");
  const ni = op === "mode night" ? args.indexOf("--note") : -1;
  if (ni >= 0 && ni + 1 < args.length && bytes(args[ni + 1]!) > NOTE_MAX_BYTES) return no("too_large", `--note ${NOTE_MAX_BYTES} baytı aşıyor`);
  if ([cid, op, requestedAt, requester, ...args].some((s) => CONTROL.test(s))) return no("control_char", "kontrol/bidi karakteri");
  if (!CID_RE.test(cid) || !REQUESTER_RE.test(requester) || requestedAt.length > 64 || Number.isNaN(Date.parse(requestedAt))) return no("bad_value", "cid/requester/requestedAt geçersiz");
  const path = commandPathOf(args);
  if (!path) return no("not_allowlisted", "bilinmeyen komut yolu");
  if (path.join(" ") !== op) return no("not_allowlisted", "op ile argv uyuşmuyor");
  if (isBlockedPath(path)) return no("not_allowlisted", "bu komut uzaktan istenemez (konsola/uzaktan açılmamış komut)");
  let bad: Bad | null = null;
  switch (op) {
    case "mode night": bad = parseFlags(args, 2, ARGV_SCHEMA["mode night"]); break;
    case "mode watch": if (args.length !== 3 || !["on", "off"].includes(args[2]!)) bad = { reason: "not_allowlisted", detail: "mode watch on|off" }; break;
    case "mode off": if (args.length !== 2) bad = { reason: "bad_flag", detail: "mode off argüman almaz" }; break;
    case "install": bad = parseFlags(args, 1, ARGV_SCHEMA.install); break;
    case "setup": bad = checkSetup(args); break;
    default: break; // genel komut: ek şema yok; boyut/kontrol karakteri sınırları yukarıda, bildirim boyutu aşağıda
  }
  if (!bad && bytes(actionLines(op, args).join("\n")) > MAX_ACTION_BYTES) return no("too_large", "istek bildirimde eksiksiz gösterilemeyecek kadar uzun");
  return bad ? no(bad.reason, bad.detail) : { ok: true, req: { v: 1, cid, op: op as Op, argv: args, requestedAt, requester } };
}

/** digest = sha256hex(JSON.stringify(["VLAD-APPROVE1", id, argv, requestedAt, expiresAt, nonce, requester, ctx.home, ctx.kb, ctx.cli])) */
export function computeDigest(p: { id: string; argv: string[]; requestedAt: string; expiresAt: string; nonce: string; requester: string; ctx: Ctx }): string {
  return createHash("sha256").update(JSON.stringify(["VLAD-APPROVE1", p.id, p.argv, p.requestedAt, p.expiresAt, p.nonce, p.requester, p.ctx.home, p.ctx.kb, p.ctx.cli])).digest("hex");
}
const mac = (key: string, s: string): string => createHmac("sha256", Buffer.from(key, "hex")).update(s, "utf8").digest("hex");
/** hex HMAC-SHA256(key, "VLAD-APPROVE1|"+digest) */
export function approveTag(modeKey: string, digest: string): string { return mac(modeKey, "VLAD-APPROVE1|" + digest); }
/** hex HMAC-SHA256(key, "VLAD-DENY1|"+digest) */
export function denyTag(modeKey: string, digest: string): string { return mac(modeKey, "VLAD-DENY1|" + digest); }
/** HMAC(key, "VLAD-GEN1") ilk 16 hex: anahtar nesli (reset/disable/rotate sonrası spawn öncesi yeniden doğrulama). */
export function keyGen(modeKey: string): string { return mac(modeKey, "VLAD-GEN1").slice(0, 16); }

const BODY_RE = /^(a1|d1)\.([a-z2-7]{26})\.([0-9a-f]{64})$/;
/** Gövde `^(a1|d1)\.<id>\.<64 hex>$`; tag servis tarafından yeniden hesaplanır (timingSafeEqual). Geçersiz = `{drop}` (tam kod). */
export function parseDecision(body: string, p: PendingRecord, modeKey: string, now: Date): { decision: "approve" | "deny" } | { drop: DropReason } {
  if (bytes(body) > 200) return { drop: "oversize" };
  const m = BODY_RE.exec(body);
  if (!m) return { drop: "bad_format" };
  if (m[2] !== p.id) return { drop: "unknown_id" };
  if (p.status !== "pending") return { drop: "not_pending" };
  const want = Buffer.from((m[1] === "a1" ? approveTag : denyTag)(modeKey, p.digest), "hex"), got = Buffer.from(m[3]!, "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { drop: "bad_tag" };
  if (!(now.getTime() < Date.parse(p.expiresAt))) return { drop: "expired" }; // NaN (bozuk kayıt) da süresi dolmuş sayılır
  return { decision: m[1] === "a1" ? "approve" : "deny" };
}

const hhmmss = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??:??:??";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};
const tilde = (p: string): string => { const h = homedir(); return h.length > 1 && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p; };
/** Bildirimde bir argüman: güvenli ASCII karakterler çıplak, diğerleri (boşluk, boş, tırnak, sembol) JSON tırnaklı; ASCII dışı her karakter `\uXXXX` (benzer harf/birleştirici işaret aldatmacası görünür; yalnız genel yolun gösteriminde, yürütülen argv değişmez). */
const quoteArg = (t: string): string => (/^[\w@%+=:,./~-]+$/.test(t) ? t : JSON.stringify(t).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
const flagValue = (argv: string[], f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

/** Bildirimin eylem bölümü (İşlem/bayrak satırları) üst sınırı (UTF-8 bayt); aşan istek validateRequest'te too_large (telefonda eksiksiz gösterilemez). */
const MAX_ACTION_BYTES = 700;

/** Eylem satırları: `İşlem: vlad <op ve pozisyonel>` + bayrak başına ayrı satır (kırpma yok; yalnız --note değeri alıntılı; değer ≤ NOTE_MAX_BYTES olduğundan kesilmez). Setup: yapılandırılmış etki özeti + `--yes` satırı. */
function actionLines(op: string, a: string[]): string[] {
  if (op === "setup" && a.includes("--uninstall")) return [`Geri alma: ${flagValue(a, "--uninstall") ?? "?"}`, "Dış etki: yok"];
  if (op === "setup") {
    const confirm = flagValue(a, "--confirm");
    return ["Yükseltme: cli, global-skills, hooks", "Kapsam: cli + global skill'ler + hooks (parça seçilemez)", `Dış etki: ${confirm ? confirm.split(",").join(", ") : "yok"}`,
      ...(a.includes("--yes") ? ["Bayrak: --yes"] : [])];
  }
  if (!LEGACY_OPS.includes(op)) return [`İşlem: vlad ${a.map(quoteArg).join(" ")}`]; // genel komut: argv birebir, her argüman tek anlamlı
  const first = a.findIndex((t) => t.startsWith("--")), cut0 = first < 0 ? a.length : first;
  const lines = [`İşlem: vlad ${a.slice(0, cut0).join(" ")}`];
  for (let i = cut0; i < a.length; i++) {
    const t = a[i]!, v = a[i + 1];
    if (v !== undefined && !v.startsWith("-") || t === "--note") { lines.push(`${t} ${t === "--note" ? `"${v ?? ""}"` : v}`); i++; } else lines.push(t);
  }
  return lines;
}

/** Bildirim şablonu golden ile kilitlidir (ayraç `\n`; `~` kısaltma; tüm bayraklar tam, `--note` ≤ 60 bayt ve kesilmez). */
export function renderNotification(p: PendingRecord): { title: string; message: string } {
  return {
    title: `VLAD onay: ${p.op}`,
    message: [...actionLines(p.op, p.argv), `İsteyen: ${p.requester} (beyan, doğrulanmamış)`, `Hedef: ${tilde(p.ctx.home)} | kb: ${tilde(p.ctx.kb)}`,
      `İstek: ${hhmmss(p.requestedAt)} · Geçerli: ${hhmmss(p.expiresAt)}`, `Kimlik: ${p.shortId}`].join("\n"),
  };
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const take = (r: RandomSource, n: number): Buffer => { const b = r.bytes(n); if (b.length < n) throw new Error("rastgelelik kaynağı yetersiz bayt verdi"); return b; };
/** 26 karakter base32 (a-z2-7). */
export function newId(r: RandomSource): string {
  let bits = "";
  for (const x of take(r, 16)) bits += x.toString(2).padStart(8, "0");
  bits = bits.padEnd(130, "0"); // 128 bit = 25 tam karakter + 3 bit (sıfır dolgu)
  let out = "";
  for (let i = 0; i < 26; i++) out += B32[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return out;
}
/** 32 hex. */
export function newNonce(r: RandomSource): string { return take(r, 16).subarray(0, 16).toString("hex"); }
/** prefix + 26 karakter base32. */
export function newTopic(prefix: "vlad-q-" | "vlad-r-", r: RandomSource): string { return prefix + newId(r); }
