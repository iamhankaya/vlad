import { RemoteError } from "../machines/types.js";
import { COMMANDS } from "../commands/manifest.js";
import { consoleTimeoutMs } from "../commands/accessors.js";

export interface CatalogEntry {
  path: string[];
  kind: "read" | "write";
  /** Değeri yalnız "-" olabilen bayraklar (içerik `stdin` alanından gelir). */
  fileFlags?: string[];
}

/**
 * Konsol (vlad-desktop) komut kataloğu: manifestten türer (src/commands/manifest.ts, tek kaynak).
 * Hariç tutulanlar manifestte `console: none` + gerekçe. `status` işaretleme yan etkisine rağmen okuma sayılır (günlüğe girmez).
 */
export const CONSOLE_CATALOG: readonly CatalogEntry[] = COMMANDS.flatMap((s): CatalogEntry[] =>
  s.console.kind === "none" ? [] : [{ path: [...s.path], kind: s.console.kind, ...(s.console.fileFlags ? { fileFlags: [...s.console.fileFlags] } : {}) }]);

const MAX_ARG = 64 * 1024;
const MAX_TOTAL = 1024 * 1024;
const forbidden = (argv: string[]) => new RemoteError("forbidden", `forbidden: komut konsoldan çalıştırılamaz: ${argv.slice(0, 2).join(" ")}`);

function match(argv: string[]): CatalogEntry | undefined {
  let best: CatalogEntry | undefined;
  for (const e of CONSOLE_CATALOG) {
    if (e.path.length <= argv.length && e.path.every((p, i) => argv[i] === p) && (!best || e.path.length > best.path.length)) best = e;
  }
  return best;
}

/** Konsoldan gelen argv'yi katalogla doğrular. İhlalde RemoteError (forbidden: katalog/dosya bayrağı; bad_request: boyut/NUL/eksik stdin). */
export function validateConsoleArgv(argv: string[], stdin?: string): { entry: CatalogEntry } {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) throw new RemoteError("bad_request", "bad_request: argv string dizisi olmalı");
  let total = 0;
  for (const a of [...argv, ...(stdin === undefined ? [] : [stdin])]) {
    if (a.includes("\0")) throw new RemoteError("bad_request", "bad_request: argüman NUL içeriyor");
    total += Buffer.byteLength(a);
  }
  if (argv.some((a) => Buffer.byteLength(a) > MAX_ARG)) throw new RemoteError("bad_request", "bad_request: argüman 64 KiB'ı aşıyor");
  if (total > MAX_TOTAL) throw new RemoteError("bad_request", "bad_request: toplam boyut 1 MiB'ı aşıyor");
  const entry = match(argv);
  if (!entry) throw forbidden(argv);
  const files = new Set(entry.fileFlags ?? []);
  for (let i = entry.path.length; i < argv.length; i++) {
    const t = argv[i]!;
    // "--" ATLANMAZ: değer alan bir seçeneğin değeri olarak tüketilebilir (--title -- --body-file x); tüm token'lar taranır
    const name = t.split("=")[0]!;
    if (files.has(name)) {
      if (t.includes("=") || argv[i + 1] !== "-") throw new RemoteError("forbidden", `forbidden: ${name} değeri yalnız '-' olabilir (içerik stdin ile)`);
      if (stdin === undefined) throw new RemoteError("bad_request", `bad_request: ${name} - için stdin gerekli`);
      i++;
    } else if (/^--[a-z-]*file$/.test(name)) throw new RemoteError("forbidden", `forbidden: ${name} bu komutta kullanılamaz`);
  }
  return { entry };
}

/** Konsol exec alt süreç sınırı: kapı komutları uzak çağrılarını (gate 30 dk, merge 330 sn) kapsar; diğerleri 110 sn (manifestteki `timeoutMs`). */
export const consoleExecTimeoutMs = (argv: string[]): number => consoleTimeoutMs(argv);
