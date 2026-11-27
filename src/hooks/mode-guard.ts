import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, isAbsolute, join, resolve } from "node:path";
import { secretDir } from "../mode/token.js";

/** F-vlad-287: çalışan oturumunda mod değişikliğini ve korumayı söken yazmaları PreToolUse'ta keser (saf). Komut kalıbı env/cwd'den bağımsızdır: `env -u VLAD_TASK_ID` ya da worktree dışı cd işe yaramaz. */
export const MODE_GUARD_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Grep", "Glob"];
/** Okuma araçları: yalnız gizli dizine (anahtar/approver spool) erişim reddedilir; başka okuma serbest. */
const READ_TOOLS = ["Read", "Grep", "Glob"];
const HINT = "ana VLAD'san ana repo dizininden çalıştır; çalışansan `vlad task ask` ile VLAD'a sor";
const WHY = `çalışan oturumu mod/koruma yazamaz: gece-bekçi modunu (kb mode.json), hook'u ve settings/vlad.config dosyalarını yalnız VLAD/kullanıcı değiştirir (${HINT})`;

export interface GuardCtx { vladHome?: string | null; cwd?: string }

/**
 * K1 (T20261128-01): APFS ad eşdeğerliği tam Unicode harf katlaması kullanır; ASCII ada açılan ASCII dışı karakterler (bu Mac'te
 * tüm kod noktaları taranarak bulundu): ſ→s, K(U+212A)→k, ß/ẞ→ss, ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ. Yalnız bu eşlemeler uygulanır; ASCII büyük/küçük
 * harf ayrımı mevcut `/i` ve toLowerCase kurallarında kalır. Rust: native/push-guard/src/text.rs `fold` (birebir tablo).
 */
const FOLD: Record<string, string> = { "ſ": "s", "K": "k", "ß": "ss", "ẞ": "ss", "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
export const fold = (s: string): string => s.replace(/[ſKßẞﬀ-ﬆ]/g, (c) => FOLD[c]!);
// Platform ayrımı: yol karşılaştırması katlanıp küçük harfe çevrilir, `\` → `/` yapılır (macOS/Windows büyük-küçük harf duyarsız).
const norm = (p: string): string => fold(p.replace(/\\/g, "/").replace(/\/+$/, "")).toLowerCase();
/** Tam realpath; yok/dangling ise ata dizini çözer, son bileşen symlink ise hedefini izler (yazma araçları symlink üzerinden de gizli dizine inemez). */
let memo: Map<string, string> | null = null; // yalnız tek checkWorkerMode çağrısı boyunca (dosya sistemi o sürede değişmiş sayılmaz)
function real(p: string, depth = 0): string {
  const abs = resolve(p);
  const hit = depth === 0 ? memo?.get(abs) : undefined;
  if (hit !== undefined) return hit;
  const out = realUncached(abs, depth);
  if (depth === 0) memo?.set(abs, out);
  return out;
}
function realUncached(abs: string, depth: number): string {
  try { return realpathSync.native(abs); } catch { /* yok ya da dangling */ }
  const parent = dirname(abs);
  const base = parent === abs ? abs : join(real(parent, depth), basename(abs));
  if (depth < 8) { try { if (lstatSync(base).isSymbolicLink()) return real(resolve(dirname(base), readlinkSync(base)), depth + 1); } catch { /* symlink değil */ } }
  return base;
}
const GLOB = /[*?[]/;
/** `?`, `*`, `[…]` joker içeren yol adı `name`'e açılabiliyor mu (mod?.json, m*e.json, mode.jso[n]); jokersiz ise tam eşitlik. */
function globHits(base: string, name: string): boolean {
  if (!GLOB.test(base)) return base.toLowerCase() === name;
  if (base.startsWith("*")) return false; // shortcut: `*.json` / `*` (rm *.json) çalışanın kendi dosyalarıdır; baş harfi bilinen joker (mod?.json) denetlenir
  const re = base.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\[[^\]]*\]/g, ".").replace(/\*/g, ".*").replace(/\?/g, ".");
  try { return new RegExp(`^${re}$`, "i").test(name); } catch { return true; }
}
/** F-vlad-287: imzalı mod belirtecinin anahtarı (gizli dizin); hook en iyi çaba katmanı, gerçek sınır CLI'daki belirteç doğrulaması. */
const SECRET = /\.vlad-secret/i; // `mode.key` tek başına aranmaz (grep/commit mesajı yanlış pozitifi); parçalı yol/joker kaçışı en iyi çaba sınırı

/** secretDir() (passwd sorgusu pahalı) çağrı başına bir kez. */
const sdir = (): string => { if (!memo) return secretDir(); let v = memo.get("\0sd"); if (v === undefined) { v = secretDir(); memo.set("\0sd", v); } return v; };
const secretHit = (t: string): boolean => { const n = norm(expand(t.replace(/["'\\]/g, ""))); return SECRET.test(n) || n === norm(sdir()) || n.startsWith(norm(sdir()) + "/"); };
const SETTINGS = ["settings.json", "settings.local.json"];
const expand = (t: string): string => t.replace(/^~(?=\/|\\|$)|\$\{?HOME\}?/g, homedir().replace(/\\/g, "/"));

/** Yol (dosya aracı ya da komut parçası) korunan mı: kb mode.json, `.claude/settings(.local).json`, `<vladHome>/dist/hooks/**`, `<vladHome>/vlad.config(.local).json` (F-vlad-406: local katman kbDir'i değiştirebilir). */
/** `anyDir`: komut parçalarında yol çözülemez (`$KB/mode.json`); mode.json adı her dizinde korunur. Dosya araçlarında yalnız kb'nin mode.json'u. */
function protectedPath(p: string, kbDir: string | null, ctx: GuardCtx, anyDir = false): string | null {
  if (secretHit(p)) return "anahtar";
  const t = expand(p.replace(/\\/g, "/"));
  if (!GLOB.test(t) && insideSecret(real(resolve(ctx.cwd ?? ".", t)))) return "anahtar"; // symlink s -> gizli dizin: yazma araçları da tam realpath ile
  const base = basename(t);
  if (globHits(base, "mode.json")) return anyDir || kbDir === null || GLOB.test(base) || norm(real(resolve(ctx.cwd ?? ".", t))) === norm(real(join(kbDir, "mode.json"))) ? "mode.json" : null; // kb dışındaki (jokersiz) mode.json projenin kendi dosyasıdır
  if (/(^|\/)\.claude\//i.test(t) && SETTINGS.some((s) => globHits(base, s))) return "settings";
  if (ctx.vladHome) {
    const abs = norm(real(isAbsolute(t) ? t : resolve(ctx.cwd ?? ".", t)));
    const home = norm(real(ctx.vladHome));
    if (abs === `${home}/vlad.config.json` || abs === `${home}/vlad.config.local.json` || abs === `${home}/dist/hooks` || abs.startsWith(`${home}/dist/hooks/`)) return "vlad";
  }
  return null;
}

// shortcut: bilinmeyen yazan araç, değişkenle kurulan yol/komut adı ve `node -e` içindeki birleştirilmiş yol kaçar; kesin sınır imzalı token (ayrı iş).
const WRITE_TOOL = /(?:^|\s)(?:tee|cp|mv|rm|truncate|dd|ln|install|perl|python3?|node|ruby|sh|bash|zsh|pwsh|powershell|jq|sponge|patch|awk|ed|curl|wget|rsync|set-content|out-file|remove-item|ni|sc)(?=\s|$)|\bsed\b[^|;&]*\s(?:-[a-z]*i|--in-place)|\bgit\s+(?:apply|checkout|restore)\b/i;
const SEP_TOKEN = /[\s;&|<>(),='"]+/;

/** Komutu tırnak dışındaki ayraçlarda (`;`, `&&`, `||`, `|`, `(`, `$(`, backtick, satır sonu) parçalara böler; tırnak içeriği kalır, tırnak/ters bölü karakterleri atılır. */
function segments(cmd: string): string[] {
  const out: string[] = []; let cur = ""; let q: string | null = null;
  const c = cmd.replace(/\\\r?\n/g, "");
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === "\\") { cur += c[++i] ?? ""; continue; }
    if (";&|(`\n".includes(ch)) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
/** Komut konumundaki `vlad mode <x>`: segment başı, öncesinde yalnız ortam atamaları/sarmalayıcılar (env, sudo, npx, node …) olabilir. */
const MODE_CMD = /^(?:[\w.-]+=\S*\s+|(?:env|command|exec|nohup|time|sudo|npx|tsx|node)\b(?:\s+-\S+(?:\s+[A-Z_]+)?)*\s+)*(?:\S*[/\\])?(?:vlad|cli)(?:\.(?:cmd|exe|js|mjs|ts|ps1))?(?:\s+-\S+)*\s+mode\b\s*(\S*)/i;
const SHELL_C = /(?:^|[\s;&|(])(?:ba|z|da)?sh\s+(?:-\S+\s+)*-\w*c\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')|\beval\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/gi;

function checkBash(cmd: string, kbDir: string | null, ctx: GuardCtx, depth: number): string | null {
  for (const m of cmd.matchAll(SHELL_C)) { // `bash -c '…'` / `eval '…'` yükü ayrıca denetlenir
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (inner && depth < 3) { const r = checkBash(inner, kbDir, ctx, depth + 1); if (r) return r; }
  }
  if (secretHit(cmd)) return `${WHY} (anahtar: gizli mod anahtarına dokunulamaz)`; // okuma bağlamı dahil: anahtarı sızdırmak da yetki sayılır
  // Windows: segments() ters eğik çizgiyi kabuk kaçışı sayıp siler (C:\Users → C:Users); sürücü harfli joker yolları kaçmasın diye ham sözcükler de denetlenir (yalnız daha sıkı)
  const rawToks = cmd.split(/[\s;&|()]+/).filter(Boolean);
  for (const seg of segments(cmd)) {
    const mm = MODE_CMD.exec(seg);
    if (mm && mm[1]!.toLowerCase() !== "status") return `${WHY}; yalnız \`vlad mode status\` serbest`;
    const clean = seg.replace(/\d*>&\d+|&?\d*>>?\s*\/dev\/null/g, " "); // 2>&1, >/dev/null yazma değildir
    const toks = clean.split(SEP_TOKEN).filter(Boolean);
    const tools = WRITE_TOOL.test(clean);
    const redirectTargets = [...clean.matchAll(/>>?\s*([^\s;&|<>()]+)/g)].map((x) => x[1]!);
    for (const t of [...clean.split(/\s+/), ...rawToks]) if (globReachesSecret(t)) return `${WHY} (anahtar: joker gizli dizine açılabilir: ${t})`;
    const kbUnder = (t: string) => kbDir !== null && norm(expand(t)).startsWith(norm(kbDir) + "/");
    for (const t of tools ? toks : redirectTargets) {
      const hit = protectedPath(t, kbDir, ctx, true) ?? (kbUnder(t) ? "kb" : null);
      if (hit) return `${WHY} (${hit}: ${t})`;
    }
  }
  return null;
}

const secretReal = (): string => norm(real(sdir()));
const insideSecret = (x: string): boolean => { const n = norm(x), sd = secretReal(); return n === sd || n.startsWith(sd + "/"); };
const ancestorOfSecret = (x: string): boolean => { const n = norm(x); return n === "" || secretReal().startsWith(n + "/"); };

/** Okuma aracı yolu gizli dizine çözülüyor mu (`base` = göreli yolun çözüldüğü dizin): `~`, `..`, symlink (tam realpath), joker kökü. `dirRoot`: arama kökü; gizli dizinin ATASI (HOME, `/`) da reddedilir (özyinelemeli arama içeri iner). */
function readsSecret(p: string, base: string, dirRoot: boolean): boolean {
  if (secretHit(p)) return true;
  // Windows: resolve ters eğik çizgi döndürür; joker kökü `/` ile kesildiği için ileri eğik çizgiye normalize edilir (aksi halde kök "/" sanılıp her yol ret olurdu)
  const abs = resolve(base, expand(p.replace(/\\/g, "/"))).replace(/\\/g, "/");
  const cut = abs.search(/[*?[{]/);
  if (cut < 0) { const f = real(abs); return insideSecret(f) || insideSecret(abs) || (dirRoot && (ancestorOfSecret(f) || ancestorOfSecret(abs))); }
  // joker: ilk jokerden önceki dizin (süslü parantez dahil) tam realpath ile çözülür; gizli dizinin içi ya da atası ise reddedilir (ad jokeri atadan erişebildiği için)
  const root = real(abs.slice(0, cut).replace(/[^/]*$/, "") || "/");
  return insideSecret(root) || ancestorOfSecret(root);
}
const DOTDOT = /(^|\/)\.\.(\/|$)/;
/** Okuma aracı denetimi: kök (path ya da cwd), `file_path`; göreli `pattern`/`glob` hem cwd'ye hem araç path'ine göre çözülür (biri isabet → ret); jokerli desende `..` doğrudan ret. */
function checkReadTool(tool: string, input: Record<string, unknown> | undefined, ctx: GuardCtx): string | null {
  const cwd = ctx.cwd ?? ".";
  const str = (k: string): string | undefined => { const v = input?.[k]; return typeof v === "string" ? v : undefined; };
  const hint = (k: string, v: string): string => `${WHY} (okuma: gizli mod anahtarı/approver dizini ${k}: ${v})`;
  const file = str("file_path");
  if (file !== undefined && readsSecret(file, cwd, false)) return hint("file_path", file);
  if (tool === "Read") return null; // Read yalnız file_path okur; arama kökü (cwd/atalar) yok (F-vlad-347)
  const root = str("path");
  if (readsSecret(root ?? ".", cwd, true)) return hint(root === undefined ? "kök(cwd)" : "path", root ?? cwd); // path verilmezse etkin kök cwd'dir
  const rootAbs = resolve(cwd, expand((root ?? ".").replace(/\\/g, "/")));
  for (const k of tool === "Glob" ? ["pattern", "glob"] : ["glob"]) {
    const v = str(k);
    if (v === undefined) continue;
    if (GLOB.test(v) && DOTDOT.test(v.replace(/\\/g, "/"))) return `${WHY} (okuma: jokerli desende '..' yasak ${k}: ${v})`;
    for (const b of new Set([cwd, rootAbs])) if (readsSecret(v, b, true)) return hint(k, v);
  }
  return null;
}

/** Bash: `~`/`$HOME`/mutlak yolla başlayan jokerli/süslü sözcük gizli dizine (ya da içine) açılabilir mi. Kabuk kuralı: baştaki nokta yalnız noktayla başlayan desenle eşleşir (`*` .vlad-secret'ı açmaz; `.*`, `.v*`, `.?lad-secret` açar). */
const braceExpand = (s: string, n = 0): string[] => {
  const m = /\{([^{}]*)\}/.exec(s);
  if (!m || n > 4 || !m[1]!.includes(",")) return [s];
  // K1 (T20261127-25): 64'e ulaşınca dur; tümünü üretip kesmek 5×60 grupta 60^5 çağrıyla kancayı askıda bırakıyordu (fail-open)
  const out: string[] = [];
  for (const alt of m[1]!.split(",")) {
    out.push(...braceExpand(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length), n + 1));
    if (out.length >= 64) break;
  }
  return out.slice(0, 64);
};
function segMatches(globSeg: string, name: string): boolean {
  globSeg = fold(globSeg); name = fold(name); // K1: gizli dizin yolu (passwd ev dizini, ör. ß) da katlanır
  if (!/[*?[]/.test(globSeg)) return globSeg.toLowerCase() === name.toLowerCase();
  if (name.startsWith(".") && !globSeg.startsWith(".")) return false;
  const re = globSeg.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\[!/g, "[^").replace(/\*+/g, ".*").replace(/\?/g, ".");
  try { return new RegExp(`^${re}$`, "i").test(name); } catch { return true; }
}
function globReachesSecret(tok: string): boolean {
  if (!/[*?[{]/.test(tok) || !/^(~|\$\{?HOME\}?|\/|[A-Za-z]:[\\/])/.test(tok)) return false; // Windows sürücü harfli mutlak yol da (C:\… / C:/…)
  const forms = [sdir(), real(sdir())].map((d) => d.replace(/\\/g, "/").split("/").filter(Boolean));
  for (const alt of braceExpand(expand(tok.replace(/\\/g, "/")))) {
    const gs = alt.split("/").filter(Boolean);
    if (forms.some((sd) => gs.every((g, i) => i >= sd.length || segMatches(g, sd[i]!)))) return true;
  }
  return false;
}

/** null = serbest, string = ret nedeni. `kbDir` null ise (çözülemedi) `mode.json` adlı her yazma reddedilir. */
export function checkWorkerMode(tool: string, input: Record<string, unknown> | undefined, kbDir: string | null, ctx: GuardCtx = {}): string | null {
  memo = new Map();
  // K1: araç girdisindeki her dize (komut, yol, desen) girişte katlanır; sonraki tüm ad/yol/komut adı eşleşmeleri katlanmış metni görür
  const folded = input && typeof input === "object" ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? fold(v) : v])) : input;
  try { return check(tool, folded, kbDir, ctx); } finally { memo = null; }
}
function check(tool: string, input: Record<string, unknown> | undefined, kbDir: string | null, ctx: GuardCtx): string | null {
  if (tool === "Bash") return checkBash(typeof input?.command === "string" ? input.command : "", kbDir, ctx, 0);
  if (!MODE_GUARD_TOOLS.includes(tool)) return null;
  if (READ_TOOLS.includes(tool)) return checkReadTool(tool, input, ctx);
  const f = input?.file_path ?? input?.notebook_path;
  if (typeof f !== "string") return null;
  const hit = protectedPath(f, kbDir, ctx);
  return hit ? `${WHY} (${hit}: ${f})` : null;
}
