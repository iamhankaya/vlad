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
/** K1: ham ya da APFS katlanmış biçim (ſ→s, ß→ss …) isabet ederse isabet; katlama uzunluğu değiştirdiği için ham biçim de denenir (`?` ß'ye açılır). */
function globHits(base: string, name: string): boolean { return globHit1(base, name) || globHit1(fold(base), name); }
function globHit1(base: string, name: string): boolean {
  if (!GLOB.test(base)) return base.toLowerCase() === name;
  if (base.startsWith("*")) return false; // shortcut: `*.json` / `*` (rm *.json) çalışanın kendi dosyalarıdır; baş harfi bilinen joker (mod?.json) denetlenir
  const re = bracketLoose(base).replace(/[.+^${}()|\\]/g, "\\$&").replace(/\[[^\]]*\]/g, ".").replace(/\*/g, ".*").replace(/\?/g, ".");
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
  const g = globProtected(t, kbDir, ctx); if (g) return g; // F-vlad-408/409 (jokersiz yolda da realpath biçimi: symlink → .claude)
  const base = basename(t);
  if (globHits(base, "mode.json")) return anyDir || kbDir === null || GLOB.test(base) || norm(real(resolve(ctx.cwd ?? ".", t))) === norm(real(join(kbDir, "mode.json"))) ? "mode.json" : null; // kb dışındaki (jokersiz) mode.json projenin kendi dosyasıdır
  if (/(^|\/)\.claude\//i.test(fold(t)) && SETTINGS.some((s) => globHits(base, s))) return "settings";
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
    if (ch === "|" && c[i - 1] === ">") { cur += ch; continue; } // F-vlad-412: `>|` noclobber yönlendirmesi bölünmez
    if (";&|(`\n".includes(ch)) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
/** Komut konumundaki `vlad mode <x>`: segment başı, öncesinde yalnız ortam atamaları/sarmalayıcılar (env, sudo, npx, node …) olabilir. */
const MODE_CMD = /^(?:[\w.-]+=\S*\s+|(?:env|command|exec|nohup|time|sudo|npx|tsx|node)\b(?:\s+-\S+(?:\s+[A-Z_]+)?)*\s+)*(?:\S*[/\\])?(?:vlad|cli)(?:\.(?:cmd|exe|js|mjs|ts|ps1))?(?:\s+-\S+)*\s+mode\b\s*(\S*)/i;
const SHELL_C = /(?:^|[\s;&|(])(?:ba|z|da)?[sſ]h\s+(?:-\S+\s+)*-\w*c\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')|\beval\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/gi;

/** F-vlad-411: zsh alternasyon/grup jokeri `(a|b)` ya da `(a)` (öncesi `$` değil, içinde boşluk/parantez yok) → `*` (fail-closed üst küme; `segments` `(` ve `|`'da böldüğü için). */
function altLoose(cmd: string): string {
  let out = "", q: string | null = null; // tırnak içi (`python3 -c "open('x','w')"`) kabuk jokeri değildir
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (q) { if (ch === q) q = null; out += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; out += ch; continue; }
    if (ch === "\\") { out += ch + (cmd[++i] ?? ""); continue; }
    if (ch === "(" && cmd[i - 1] !== "$") {
      const close = cmd.slice(i + 1).search(/[()\s]/);
      if (close >= 0 && cmd[i + 1 + close] === ")") { out += "*"; i += close + 1; continue; }
    }
    out += ch;
  }
  return out;
}
const DESTROY = /(?:^|\s)(?:rm|mv|rmdir|unlink|shred|trash(?:-put)?)(?=\s|$)/i;
const COPYISH = /(?:^|\s)(?:cp|install|rsync|ln|scp)(?=\s|$)/i;
const CD_CMD = /^(?:cd|pushd|chdir)(?:\s+(?:--|-[LPe@]+))*(?:\s+(\S+))?\s*$/i;

function checkBash(cmd: string, kbDir: string | null, ctx0: GuardCtx, depth: number): string | null {
  for (const m of cmd.matchAll(SHELL_C)) { // `bash -c '…'` / `eval '…'` yükü ayrıca denetlenir
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (inner && depth < 3) { const r = checkBash(inner, kbDir, ctx0, depth + 1); if (r) return r; }
  }
  cmd = altLoose(cmd);
  let ctx = ctx0; // `cd <dizin>` sonrası göreli yollar o dizine göre çözülür (bilgi maddesi: cwd izleme)
  if (secretHit(cmd)) return `${WHY} (anahtar: gizli mod anahtarına dokunulamaz)`; // okuma bağlamı dahil: anahtarı sızdırmak da yetki sayılır
  // Windows: segments() ters eğik çizgiyi kabuk kaçışı sayıp siler (C:\Users → C:Users); sürücü harfli joker yolları kaçmasın diye ham sözcükler de denetlenir (yalnız daha sıkı)
  const rawToks = cmd.split(/[\s;&|()]+/).filter(Boolean);
  for (const seg of segments(cmd)) {
    const mm = MODE_CMD.exec(fold(seg)); // K1: komut adı PATH'te APFS ile çözülür (katlama yalnız eşleşmede; yollar ham kalır)
    if (mm && mm[1]!.toLowerCase() !== "status") return `${WHY}; yalnız \`vlad mode status\` serbest`;
    const cd = CD_CMD.exec(seg);
    if (cd) { // sanal cwd: yalnız çözülebilir hedef (`$VAR`, `-`, joker yok); çözülemeyen cd cwd'yi değiştirmez (kestirme)
      const t = cd[1];
      if (t === undefined) ctx = { ...ctx, cwd: homedir() };
      else if (t !== "-" && !/[$*?[{~]/.test(expand(t))) ctx = { ...ctx, cwd: resolve(ctx.cwd ?? ".", expand(t.replace(/\\/g, "/"))) };
    }
    const clean = seg.replace(/\d*>&\d+|&?\d*>>?\s*\/dev\/null/g, " "); // 2>&1, >/dev/null yazma değildir
    const toks = clean.split(SEP_TOKEN).filter(Boolean);
    const tools = WRITE_TOOL.test(fold(clean)); // K1: ſed, baſh, inſtall, awK
    const redirectTargets = [...clean.matchAll(/>[>|]?\s*([^\s;&|<>()]+)/g)].map((x) => x[1]!); // `>|` noclobber (F-vlad-412)
    for (const t of [...clean.split(/\s+/), ...rawToks]) if (globReachesSecret(t)) return `${WHY} (anahtar: joker gizli dizine açılabilir: ${t})`;
    const destroy = DESTROY.test(fold(clean)), copyish = COPYISH.test(fold(clean));
    const kbUnder = (t: string) => kbDir !== null && norm(expand(t)).startsWith(norm(kbDir) + "/");
    // F-vlad-408/409: SEP_TOKEN virgülde böler; `{a,b}` süslü sözcükler boşlukla bölünmüş haliyle de denetlenir
    for (const t of tools ? [...toks, ...clean.split(/\s+/).filter((x) => x.includes("{"))] : redirectTargets) {
      const hit = protectedPath(t, kbDir, ctx, true) ?? (kbUnder(t) ? "kb" : null) ?? (tools && (destroy || copyish) ? dirProtected(t, kbDir, ctx, destroy) : null);
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
/** Kabuk `{x..y}` dizisi (virgülsüz brace) → `*` (fail-closed üst küme; braceExpand yalnız virgüllü grubu açar). */
const seqLoose = (s: string): string => s.replace(/\{[^{},]*\.\.[^{},]*\}/g, "*");
/**
 * Köşeli parantez ifadesi JS regex'te yanlış okunur → `?` (fail-closed): POSIX sınıfı (`[[:lower:]]`, birden çok: `[[:alpha:][:digit:]]`),
 * collating (`[[.o.]]`), eşdeğerlik (`[[=o=]]`) ya da `]` ile başlayan (`[]n]`, `[!]x]`) sınıf. F-vlad-410: tek sınıf regex'i çoklu sınıfı kaçırıyordu; tarayıcı.
 */
function bracketLoose(s: string): string {
  let out = "", i = 0;
  while (i < s.length) {
    if (s[i] !== "[") { out += s[i++]; continue; }
    let j = i + 1, odd = false;
    if (s[j] === "!" || s[j] === "^") j++;
    if (s[j] === "]") { odd = true; j++; }
    let end = -1;
    for (; j < s.length; j++) {
      const c = s[j]!, n = s[j + 1];
      if (c === "[" && n !== undefined && ":.=".includes(n)) { const close = s.indexOf(n + "]", j + 2); if (close >= 0) { odd = true; j = close + 1; continue; } }
      if (c === "]") { end = j; break; }
    }
    if (end < 0) { out += s[i++]; continue; } // kapanmamış `[` düz karakter
    out += odd ? "?" : s.slice(i, end + 1);
    i = end + 1;
  }
  return out;
}
/** Açılım sınırı (64 alternatif / 4 derinlik) aşıldı mı: kalan virgüllü grup ya da tam 64 açılım → fail-closed. */
const braceCapped = (alts: string[]): boolean => alts.length >= 64 || alts.some((a) => /\{[^{}]*,[^{}]*\}/.test(a));
/** K1: ham çift (kabuk `?` ß'ye açılır) ya da iki tarafı APFS katlanmış çift (gizli dizin yolu ß içerebilir) eşleşirse isabet. */
function segMatches(globSeg: string, name: string): boolean { globSeg = bracketLoose(globSeg); return segMatch1(globSeg, name) || segMatch1(fold(globSeg), fold(name)); }
function segMatch1(globSeg: string, name: string): boolean {
  if (!/[*?[]/.test(globSeg)) return globSeg.toLowerCase() === name.toLowerCase();
  if (name.startsWith(".") && !globSeg.startsWith(".")) return false;
  const re = globSeg.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\[!/g, "[^").replace(/\*+/g, ".*").replace(/\?/g, ".");
  try { return new RegExp(`^${re}$`, "i").test(name); } catch { return true; }
}
function globReachesSecret(tok: string): boolean {
  if (!/[*?[{]/.test(tok) || !/^\{?(~|\$\{?HOME\}?|\/|[A-Za-z]:[\\/])/.test(tok)) return false; // Windows sürücü harfli mutlak yol da (C:\… / C:/…); review tur 2: `{~/…,x}`
  const forms = [sdir(), real(sdir())].map((d) => d.replace(/\\/g, "/").split("/").filter(Boolean));
  const alts = braceExpand(seqLoose(expand(tok.replace(/\\/g, "/"))));
  if (braceCapped(alts)) return true; // açılım sınırı: fail-closed
  for (const alt of alts) {
    const gs = expand(alt).split("/").filter(Boolean);
    if (forms.some((sd) => gs.every((g, i) => i >= sd.length || segMatches(g, sd[i]!)))) return true;
  }
  return false;
}

const segsOf = (p: string): string[] => p.replace(/\\/g, "/").split("/").filter(Boolean);
/**
 * F-vlad-408/409: jokerli (`*?[` / `{a,b}`) yol korunan bir yola açılabiliyor mu. Yol mutlaklaştırılır, bileşenlere ayrılır;
 * jokerli her bileşen segMatches (ham + APFS katlı, baştaki nokta kuralı) ile korunan ada sınanır; `*` kestirmesi yok.
 * Jokersiz önek ayrıca realpath'lenir (symlink → ~/.claude). Hedefler: gizli dizin (ve altı), herhangi bir dizindeki `.claude/settings(.local).json`,
 * `<vladHome>/vlad.config(.local).json`, `<vladHome>/dist/hooks/**`, `<kb>/mode.json`.
 */
function globProtected(t: string, kbDir: string | null, ctx: GuardCtx): string | null {
  const forms = pathForms(t, ctx);
  if (forms === null) return "joker-sınırı"; // review tur 2: 64+ alternatif / 5+ grup sessizce kesilmesin
  const roots = (d: string): string[][] => [segsOf(d), segsOf(real(d))];
  const hits = (gs: string[], target: string[], prefix: boolean): boolean => (prefix ? gs.length >= target.length : gs.length === target.length) && target.every((s, i) => segMatches(gs[i]!, s));
  for (const gs of forms) {
    const n = gs.length;
    if (roots(sdir()).some((r) => hits(gs, r, true))) return "anahtar"; // jokerle gizli dizine yazma (`> ~/.vlad-secre*/mode.key`)
    if (n >= 2 && segMatches(gs[n - 2]!, ".claude") && SETTINGS.some((s) => segMatches(gs[n - 1]!, s))) return "settings";
    if (kbDir !== null && roots(kbDir).some((r) => hits(gs, [...r, "mode.json"], false))) return "mode.json";
    if (ctx.vladHome) {
      for (const r of roots(ctx.vladHome)) {
        if (hits(gs, [...r, "vlad.config.json"], false) || hits(gs, [...r, "vlad.config.local.json"], false) || hits(gs, [...r, "dist", "hooks"], true)) return "vlad";
      }
    }
  }
  return null;
}

/**
 * F-vlad-413: silme/taşıma (`destroy`) ya da kopyalama hedefi korunan KÖKÜN kendisi ya da atası mı (jokerle açılabilen dahil).
 * destroy: hedef, korunan dizinlerin (gizli dizin, `~/.claude`, kb, `<vladHome>/dist/hooks`) eşi ya da atasıdır (`rm -rf ~/.claude`, `rm -rf $VH/di*`, `mv ~/.cla* x`;
 * `<vladHome>` ve `dist` zincirde olduğundan dahil); herhangi bir dizinde adı `.claude` olan hedef de.
 * kopyalama: hedef bu dizinlerden birinin (+ `<vladHome>`, `<vladHome>/dist`) tam eşi (`cp x ~/.claude/`, `cp -t ~/.claude`, `cp -r hooks $VH/di?t`); ata dizine kopyalama serbest (dosya adı korunan olamaz).
 */
function dirProtected(t: string, kbDir: string | null, ctx: GuardCtx, destroy: boolean): string | null {
  const forms = pathForms(expand(t), ctx);
  if (forms === null) return null; // sınır aşımı protectedPath'te zaten reddedildi
  const home = segsOf(homedir());
  const dirs: Array<[string[], string]> = [];
  const add = (d: string, kind: string, tail: string[] = []): void => { for (const r of [segsOf(d), segsOf(real(d))]) dirs.push([[...r, ...tail], kind]); };
  add(sdir(), "anahtar"); dirs.push([[...home, ".claude"], "settings"]);
  if (kbDir !== null) add(kbDir, "kb");
  if (ctx.vladHome) { add(ctx.vladHome, "vlad", ["dist", "hooks"]); if (!destroy) { add(ctx.vladHome, "vlad", ["dist"]); add(ctx.vladHome, "vlad"); } }
  const eq = (gs: string[], target: string[]): boolean => gs.length === target.length && target.every((s, i) => segMatches(gs[i]!, s));
  const anc = (gs: string[], target: string[]): boolean => gs.length <= target.length && gs.every((g, i) => segMatches(g, target[i]!));
  for (const gs of forms) {
    if (gs.length > 0 && segMatches(gs[gs.length - 1]!, ".claude")) return "settings"; // herhangi bir dizindeki `.claude` (settings kuralıyla aynı kapsam)
    for (const [d, kind] of dirs) if (destroy ? anc(gs, d) : eq(gs, d)) return kind;
  }
  return null;
}

/** Yol → mutlak bileşen biçimleri (brace açılımı, tilde, cwd, jokersiz önek realpath'i); açılım sınırı aşılırsa null. */
function pathForms(t: string, ctx: GuardCtx): string[][] | null {
  const forms: string[][] = [];
  const alts = braceExpand(seqLoose(t));
  if (braceCapped(alts)) return null;
  for (const raw of alts) {
    const alt = expand(raw); // kabuk sırası: önce brace, sonra her sözcükte tilde (`{~/.claude/settings.json,x}`)
    const abs = resolve(ctx.cwd ?? ".", alt).replace(/\\/g, "/");
    forms.push(segsOf(abs));
    const parts = abs.split("/");
    const k = parts.findIndex((s) => /[*?[]/.test(s));
    if (k > 0) forms.push([...segsOf(real(parts.slice(0, k).join("/") + "/")), ...parts.slice(k).filter(Boolean)]);
    else if (k < 0) forms.push(segsOf(real(abs)));
  }
  return forms;
}

/** null = serbest, string = ret nedeni. `kbDir` null ise (çözülemedi) `mode.json` adlı her yazma reddedilir. */
export function checkWorkerMode(tool: string, input: Record<string, unknown> | undefined, kbDir: string | null, ctx: GuardCtx = {}): string | null {
  memo = new Map();
  // K1: girdi ham kalır (realpath/lstat/readlink ham adla: Linux/NTFS/harf duyarlı APFS'te ſx ≠ sx); APFS katlaması yalnız
  // karşılaştırmalarda: norm, globHits, segMatches, `.claude` / WRITE_TOOL / MODE_CMD / SHELL_C eşleşmeleri
  try { return check(tool, input, kbDir, ctx); } finally { memo = null; }
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
