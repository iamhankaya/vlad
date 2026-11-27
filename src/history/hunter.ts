// `vlad history` ↔ hunter (oturum kayıtları arama motoru, ayrı Rust reposu) ince sarmalayıcısı (T20261127-21).
// hunter'ın `--json` şeması v1 sözleşmesi hunter reposunun `docs/json-schema-v1.md`'sindedir; burada yalnız `schema`
// sürümü denetlenir, alanlar aynen geçirilir. Bulma: PATH, yoksa vlad.config.json `hunterPath`.
import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { HistoryError } from "./errors.js";

/** Dizin bu kadar saniyeden eskiyse `history search` uyarı verir. */
export const STALE_AFTER_S = 24 * 3600;
const HUNTER_TIMEOUT_MS = 60_000;
const SCHEMA = 1;

export const INSTALL_HINTS = [
  "kurulum: cargo install --path ~/dev/hunter (ikili ~/.cargo/bin/hunter)",
  "PATH'te değilse vlad.config.json (ya da vlad.config.local.json) \"hunterPath\": \"<hunter ikilisinin mutlak yolu>\"",
];

export { HistoryError };

export interface LocateOptions {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** vlad.config.json `hunterPath`: mutlak, `~/` ile ya da VLAD_HOME'a göre göreli. */
  hunterPath?: string;
  vladHome: string;
}
export interface Located { bin: string | null; tried: string[] }

function isExecutable(p: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** hunter ikilisini bulur: önce PATH, sonra `hunterPath`. Çalıştırmaz (salt dosya sistemi). */
export function locateHunter(o: LocateOptions): Located {
  const platform = o.platform ?? process.platform;
  const names = platform === "win32" ? ["hunter.exe", "hunter.cmd"] : ["hunter"];
  const pathVar = o.env.PATH ?? o.env.Path ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (isExecutable(p, platform)) return { bin: p, tried: [] };
    }
  }
  const tried = ["PATH: hunter yok"];
  if (o.hunterPath) {
    const p = resolve(o.vladHome, expandHome(o.hunterPath));
    if (isExecutable(p, platform)) return { bin: p, tried: [] };
    tried.push(`hunterPath: ${p} bulunamadı ya da çalıştırılamıyor`);
  } else tried.push("hunterPath: tanımsız (vlad.config.json)");
  return { bin: null, tried };
}

export type HunterRun = (bin: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };

export const defaultRun: HunterRun = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: HUNTER_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) };
};

export interface HunterDeps {
  bin: string | null;
  /** locateHunter'ın denedikleri (bin null iken hata ayrıntısı). */
  tried?: string[];
  run?: HunterRun;
}

const HINT_BY_CODE: Record<string, string> = {
  no_index: "dizin yok: önce `hunter index` (ilk tam dizinleme birkaç dakika sürer)",
  lock_busy: "dizinleme sürüyor; biraz sonra tekrar dene",
  root_mismatch: "dizin başka bir kayıt kökü için kurulmuş: `hunter index --full`",
};

function hunterJson<T extends { schema?: unknown }>(args: string[], deps: HunterDeps): T {
  if (!deps.bin) throw new HistoryError("hunter bulunamadı", [...(deps.tried ?? []), ...INSTALL_HINTS]);
  const r = (deps.run ?? defaultRun)(deps.bin, args);
  if (r.error) throw new HistoryError(`hunter çalıştırılamadı: ${r.error.message}`, [`bin: ${deps.bin}`]);
  if (r.status !== 0) {
    const last = r.stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    let parsed: { error?: unknown; code?: unknown; details?: unknown } | null = null;
    try { parsed = JSON.parse(last); } catch { /* clap kullanım hatası düz metindir */ }
    if (parsed && typeof parsed.error === "string") {
      const code = typeof parsed.code === "string" ? parsed.code : "";
      const details = [...(code ? [`code: ${code}`] : []), ...(Array.isArray(parsed.details) ? parsed.details.map(String) : []), ...(HINT_BY_CODE[code] ? [HINT_BY_CODE[code]!] : [])];
      throw new HistoryError(`hunter: ${parsed.error}`, details);
    }
    const text = r.stderr.trim().split(/\r?\n/)[0] || `çıkış kodu ${r.status}`;
    throw new HistoryError(`hunter: ${text.replace(/^error: /, "")}`, [`çıkış kodu: ${r.status}`]);
  }
  let out: T;
  try { out = JSON.parse(r.stdout) as T; } catch (e) { throw new HistoryError(`hunter çıktısı okunamadı: ${(e as Error).message}`); }
  if (!out || out.schema !== SCHEMA) throw new HistoryError(`hunter --json şema sürümü beklenmiyor: ${String(out?.schema)} (vlad şema ${SCHEMA} bekliyor; hunter ya da vlad güncel değil)`);
  return out;
}

export interface SearchParams {
  query: string;
  project?: string;
  task?: string;
  since?: string;
  until?: string;
  limit?: string | number;
  all?: boolean;
}
/** hunter `search --json` çıktısı (şema v1); alanlar aynen geçer. */
export interface SearchOutput {
  schema: 1;
  query: string;
  took_ms: number;
  total_hits: number;
  returned: number;
  last_indexed: string | null;
  index_age_s: number | null;
  warnings: string[];
  results: { id: string; score: number; ts: string; project: string; task: string | null; session: string; role: string; kind: string; tool: string | null; sidechain: boolean; source_deleted: boolean; path: string; line: number; cwd: string; snippet: string }[];
}

export function staleWarning(out: Pick<SearchOutput, "last_indexed" | "index_age_s">): string | null {
  if (out.last_indexed === null || out.index_age_s === null) return "dizin hiç tamamlanmamış; tazelemek için: hunter index";
  if (out.index_age_s > STALE_AFTER_S) return `dizin 24 saatten eski (son dizinleme ${out.last_indexed}, ${Math.floor(out.index_age_s / 3600)} saat önce); son oturumlar eksik olabilir, tazelemek için: hunter index`;
  return null;
}

export function historySearch(p: SearchParams, deps: HunterDeps): SearchOutput {
  const args = ["search", "--json"];
  if (p.project) args.push("--project", p.project);
  if (p.task) args.push("--task", p.task);
  if (p.since) args.push("--since", p.since);
  if (p.until) args.push("--until", p.until);
  if (p.limit !== undefined) args.push("--limit", String(p.limit));
  if (p.all) args.push("--all");
  args.push("--", p.query);
  const out = hunterJson<SearchOutput>(args, deps);
  const warnings = Array.isArray(out.warnings) ? out.warnings : [];
  const stale = staleWarning(out);
  return { ...out, warnings: stale ? [...warnings, stale] : warnings };
}

/** hunter `show --json` çıktısı (şema v1). */
export interface ShowOutput {
  schema: 1;
  id: string;
  path: string;
  session: string;
  project: string;
  task: string | null;
  sidechain: boolean;
  source_deleted: boolean;
  messages: { line: number; ts: string; target: boolean; blocks: { block: number; role: string; kind: string; tool: string | null; text: string }[] }[];
}

export function historyShow(id: string, o: { context?: string | number }, deps: HunterDeps): ShowOutput {
  const args = ["show", "--json"];
  if (o.context !== undefined) args.push("--context", String(o.context));
  args.push("--", id);
  return hunterJson<ShowOutput>(args, deps);
}

type Spawn = (bin: string, args: string[], opts: SpawnOptions) => Pick<ChildProcess, "pid" | "unref" | "on">;
export interface TriggerOptions {
  locate: () => string | null;
  spawn?: Spawn;
}

/**
 * SessionEnd hook'u: `hunter index --if-exists --quiet`'i ayrık süreç olarak başlatır, beklemez (oturum kapanışı
 * gecikmez). hunter yoksa, dizin yoksa (`--if-exists`) ya da kilit tutuluyorsa (hunter çıkış 75, çıktısı atılır) sessizdir.
 * Döner: başlatılan sürecin pid'i ya da null. Asla atmaz.
 */
export function triggerHunterIndex(o: TriggerOptions): number | null {
  try {
    const bin = o.locate();
    if (!bin) return null;
    const child = (o.spawn ?? nodeSpawn)(bin, ["index", "--if-exists", "--quiet"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => { /* ENOENT/EACCES async: sessiz */ });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}
