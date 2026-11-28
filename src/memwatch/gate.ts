import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MONITOR_DIRNAME } from "../monitor/state.js";
import { nativeAllowed } from "../platform/native.js";

/**
 * Bellek kapısı (T20261128-06): `vlad task launch` çalışan açmadan önce sistem bellek baskısına bakar.
 * Kaynak sırası: memwatch daemon'un taze durum dosyası (`~/.vlad-monitor/memwatch.json`, ≤ 60 sn) → `memwatch check --json`
 * (ikili varsa) → bilinmiyor (asla engellemez). Şema `native/memwatch/src/state.rs` / `report.rs` ile aynı.
 */
export type MemLevel = "ok" | "warn" | "critical";
export interface MemSystem { total_bytes: number; free_pct: number; pressure: string; swap_total_bytes: number; swap_used_bytes: number }
export interface MemGroup { id: string; kind: "task" | "vlad" | "vm" | "terminal"; footprint_bytes: number; procs: number; top: { pid: number; name: string; footprint_bytes: number } | null }
export interface MemSnapshot { ts: number; level: MemLevel; reasons: string[]; system: MemSystem; vlad_bytes: number; groups: MemGroup[] }
export interface MemwatchState { v: 1; updated: number; pid: number; interval_secs: number; rss_bytes: number; last: MemSnapshot }

export interface MemoryReading { level: MemLevel | "unknown"; source: "state" | "check" | "none"; reasons: string[]; summary: string }

export const MEMWATCH_STATE_NAME = "memwatch.json";
export const defaultMemwatchStatePath = (home: string = homedir()): string => join(home, MONITOR_DIRNAME, MEMWATCH_STATE_NAME);
/** Durum dosyası bundan eskiyse (sn) daemon durmuş sayılır. */
export const STATE_MAX_AGE_S = 60;
const CHECK_TIMEOUT_MS = 5_000;

/** Çıkış 75 (EX_TEMPFAIL): bellek baskısı geçicidir, sonra yeniden denenebilir. */
export class MemoryGateError extends Error {
  constructor(message: string) { super(message); this.name = "MemoryGateError"; }
}

const LEVELS = new Set(["ok", "warn", "critical"]);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
function validSnapshot(x: unknown): x is MemSnapshot {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  const sys = s.system as Record<string, unknown> | undefined;
  return LEVELS.has(s.level as string) && Array.isArray(s.reasons) && s.reasons.every((r) => typeof r === "string")
    && !!sys && typeof sys === "object" && isNum(sys.free_pct) && isNum(sys.swap_used_bytes) && isNum(sys.swap_total_bytes)
    && typeof sys.pressure === "string" && isNum(s.vlad_bytes);
}

/** Taze ve geçerli durum dosyası; yok, bozuk, bayat ya da ileri tarihli ise null. */
export function readMemoryState(path: string, nowMs: number = Date.now()): MemwatchState | null {
  let o: unknown;
  try { o = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const s = o as Partial<MemwatchState> | null;
  if (!s || s.v !== 1 || !isNum(s.updated) || !validSnapshot(s.last)) return null;
  const age = nowMs / 1000 - s.updated;
  return age <= STATE_MAX_AGE_S && age >= -STATE_MAX_AGE_S ? (s as MemwatchState) : null;
}

const gib = (b: number): string => `${(b / 1024 ** 3).toFixed(1)} GiB`;
export function summarize(s: MemSnapshot): string {
  const why = s.reasons.length ? ` (${s.reasons.join("; ")})` : "";
  return `${s.level}${why}: boş %${s.system.free_pct}, baskı ${s.system.pressure}, swap ${gib(s.system.swap_used_bytes)}/${gib(s.system.swap_total_bytes)}, vlad ${gib(s.vlad_bytes)}`;
}

export type RunCheck = (bin: string, args: string[]) => { status: number | null; stdout: string };
const realRun: RunCheck = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: CHECK_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout };
};

export interface ReadMemoryDeps {
  statePath: string;
  /** memwatch ikilisi; null → yalnız durum dosyası. */
  binary: string | null;
  now?: () => number;
  run?: RunCheck;
}

const UNKNOWN: MemoryReading = { level: "unknown", source: "none", reasons: [], summary: "" };
const reading = (s: MemSnapshot, source: "state" | "check"): MemoryReading => ({ level: s.level, source, reasons: [...s.reasons], summary: summarize(s) });

export function readMemory(d: ReadMemoryDeps): MemoryReading {
  const st = readMemoryState(d.statePath, (d.now ?? Date.now)());
  if (st) return reading(st.last, "state");
  if (!d.binary) return UNKNOWN;
  try {
    const r = (d.run ?? realRun)(d.binary, ["check", "--json"]);
    if (r.status !== 0) return UNKNOWN;
    const snap: unknown = JSON.parse(r.stdout);
    return validSnapshot(snap) ? reading(snap, "check") : UNKNOWN;
  } catch { return UNKNOWN; }
}

/** `<dist>/bin/memwatch`: CLI `dist/cli.js` olduğundan ikili onun yanındaki `bin/` altındadır. */
export const memwatchBinaryFor = (cliPath: string): string => join(dirname(cliPath), "bin", process.platform === "win32" ? "memwatch.exe" : "memwatch");

/**
 * `vlad task launch` kaynakları. `VLAD_MEMWATCH_STATE` durum dosyası yolunu ezer (testte sahte dosya). Testlerde
 * (`VLAD_NO_NATIVE=1`) ezme yoksa kapı hiç okumaz: gerçek `~/.vlad-monitor` ve gerçek ikili test sonucunu etkilemesin.
 */
export function launchMemoryDeps(env: NodeJS.ProcessEnv, cliPath: string): ReadMemoryDeps | null {
  const override = env.VLAD_MEMWATCH_STATE;
  if (!override && !nativeAllowed(env)) return null;
  const bin = memwatchBinaryFor(cliPath);
  return { statePath: override || defaultMemwatchStatePath(), binary: nativeAllowed(env) && existsSync(bin) ? bin : null };
}

/** critical → MemoryGateError (`--force` yoksa); warn ya da zorlanmış critical → uyarı satırı; ok/unknown → sessiz. */
export function memoryGate(r: MemoryReading, o: { force: boolean; warn: (line: string) => void }): void {
  if (r.level === "critical") {
    if (!o.force) throw new MemoryGateError(`bellek: kritik baskı, çalışan başlatılmadı — ${r.summary}; yine de başlatmak için --force`);
    o.warn(`bellek: kritik baskı, --force ile geçildi — ${r.summary}`);
  } else if (r.level === "warn") {
    o.warn(`bellek: uyarı — ${r.summary}`);
  }
}
