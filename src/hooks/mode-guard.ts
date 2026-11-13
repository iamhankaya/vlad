import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, isAbsolute, join, resolve } from "node:path";
import { secretDir } from "../mode/token.js";

/** F-vlad-287: çalışan oturumunda mod değişikliğini ve korumayı söken yazmaları PreToolUse'ta keser (saf). Komut kalıbı env/cwd'den bağımsızdır: `env -u VLAD_TASK_ID` ya da worktree dışı cd işe yaramaz. */
export const MODE_GUARD_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"];
const HINT = "ana VLAD'san ana repo dizininden çalıştır; çalışansan `vlad task ask` ile VLAD'a sor";
const WHY = `çalışan oturumu mod/koruma yazamaz: gece-bekçi modunu (kb mode.json), hook'u ve settings/vlad.config dosyalarını yalnız VLAD/kullanıcı değiştirir (${HINT})`;

export interface GuardCtx { vladHome?: string | null; cwd?: string }

// Platform ayrımı: yol karşılaştırması küçük harfe çevrilip `\` → `/` yapılır (macOS/Windows büyük-küçük harf duyarsız).
const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
function real(p: string): string {
  const abs = resolve(p);
  try { return join(realpathSync.native(dirname(abs)), basename(abs)); } catch { return abs; }
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
const SECRET = /\.vlad-secret|mode\.key/i;
const secretHit = (t: string): boolean => { const n = norm(expand(t.replace(/["'\\]/g, ""))); return SECRET.test(n) || n === norm(secretDir()) || n.startsWith(norm(secretDir()) + "/"); };
const SETTINGS = ["settings.json", "settings.local.json"];
const expand = (t: string): string => t.replace(/^~(?=\/|\\|$)|\$\{?HOME\}?/g, homedir().replace(/\\/g, "/"));

/** Yol (dosya aracı ya da komut parçası) korunan mı: kb mode.json, `.claude/settings(.local).json`, `<vladHome>/dist/hooks/**`, `<vladHome>/vlad.config.json`. */
/** `anyDir`: komut parçalarında yol çözülemez (`$KB/mode.json`); mode.json adı her dizinde korunur. Dosya araçlarında yalnız kb'nin mode.json'u. */
function protectedPath(p: string, kbDir: string | null, ctx: GuardCtx, anyDir = false): string | null {
  if (secretHit(p)) return "anahtar";
  const t = expand(p.replace(/\\/g, "/"));
  const base = basename(t);
  if (globHits(base, "mode.json")) return anyDir || kbDir === null || GLOB.test(base) || norm(real(resolve(ctx.cwd ?? ".", t))) === norm(real(join(kbDir, "mode.json"))) ? "mode.json" : null; // kb dışındaki (jokersiz) mode.json projenin kendi dosyasıdır
  if (/(^|\/)\.claude\//i.test(t) && SETTINGS.some((s) => globHits(base, s))) return "settings";
  if (ctx.vladHome) {
    const abs = norm(real(isAbsolute(t) ? t : resolve(ctx.cwd ?? ".", t)));
    const home = norm(real(ctx.vladHome));
    if (abs === `${home}/vlad.config.json` || abs === `${home}/dist/hooks` || abs.startsWith(`${home}/dist/hooks/`)) return "vlad";
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
  for (const seg of segments(cmd)) {
    const mm = MODE_CMD.exec(seg);
    if (mm && mm[1]!.toLowerCase() !== "status") return `${WHY}; yalnız \`vlad mode status\` serbest`;
    const clean = seg.replace(/\d*>&\d+|&?\d*>>?\s*\/dev\/null/g, " "); // 2>&1, >/dev/null yazma değildir
    const toks = clean.split(SEP_TOKEN).filter(Boolean);
    const tools = WRITE_TOOL.test(clean);
    const redirectTargets = [...clean.matchAll(/>>?\s*([^\s;&|<>()]+)/g)].map((x) => x[1]!);
    const kbUnder = (t: string) => kbDir !== null && norm(expand(t)).startsWith(norm(kbDir) + "/");
    for (const t of tools ? toks : redirectTargets) {
      const hit = protectedPath(t, kbDir, ctx, true) ?? (kbUnder(t) ? "kb" : null);
      if (hit) return `${WHY} (${hit}: ${t})`;
    }
  }
  return null;
}

/** null = serbest, string = ret nedeni. `kbDir` null ise (çözülemedi) `mode.json` adlı her yazma reddedilir. */
export function checkWorkerMode(tool: string, input: Record<string, unknown> | undefined, kbDir: string | null, ctx: GuardCtx = {}): string | null {
  if (tool === "Bash") return checkBash(typeof input?.command === "string" ? input.command : "", kbDir, ctx, 0);
  if (!MODE_GUARD_TOOLS.includes(tool)) return null;
  const f = input?.file_path ?? input?.notebook_path;
  if (typeof f !== "string") return null;
  const hit = protectedPath(f, kbDir, ctx);
  return hit ? `${WHY} (${hit}: ${f})` : null;
}
