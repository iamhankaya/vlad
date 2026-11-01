import { RemoteError } from "../machines/types.js";

export interface CatalogEntry {
  path: string[];
  kind: "read" | "write";
  /** Değeri yalnız "-" olabilen bayraklar (içerik `stdin` alanından gelir). */
  fileFlags?: string[];
}

/**
 * Konsol (vlad-desktop) komut kataloğu: tek kaynak. vlad-desktop `catalog/commands.json` ile eşitlenir (D4 testi).
 * Hariç tutulanlar: agent, machine, queue, remote, install. `status` işaretleme yan etkisine rağmen okuma sayılır (günlüğe girmez).
 */
export const CONSOLE_CATALOG: readonly CatalogEntry[] = [
  { path: ["scan"], kind: "read" },
  { path: ["project", "write"], kind: "write", fileFlags: ["--file"] },
  { path: ["project", "set"], kind: "write" },
  { path: ["project", "note"], kind: "write", fileFlags: ["--file"] },
  { path: ["project", "status"], kind: "read" },
  { path: ["project", "summary"], kind: "write", fileFlags: ["--file"] },
  { path: ["project", "list"], kind: "read" },
  { path: ["finding", "add"], kind: "write", fileFlags: ["--detail-file"] },
  { path: ["finding", "list"], kind: "read" },
  { path: ["finding", "set"], kind: "write" },
  { path: ["role", "list"], kind: "read" },
  { path: ["task", "new"], kind: "write", fileFlags: ["--body-file"] },
  { path: ["task", "launch"], kind: "write" },
  { path: ["task", "ingest"], kind: "write", fileFlags: ["--events-file", "--file"] },
  { path: ["task", "log"], kind: "write" },
  { path: ["task", "ask"], kind: "write" },
  { path: ["task", "answer"], kind: "write" },
  { path: ["task", "report"], kind: "write", fileFlags: ["--file"] },
  { path: ["task", "set"], kind: "write" },
  { path: ["task", "deps"], kind: "write" },
  { path: ["task", "resume"], kind: "write" },
  { path: ["task", "close-window"], kind: "write" },
  { path: ["task", "cleanup"], kind: "write" },
  { path: ["task", "digested"], kind: "write" },
  { path: ["task", "session"], kind: "write" },
  { path: ["task", "list"], kind: "read" },
  { path: ["task", "idle"], kind: "read" },
  { path: ["task", "ready"], kind: "read" },
  { path: ["task", "gate"], kind: "write" },
  { path: ["task", "merge-preview"], kind: "read" },
  { path: ["task", "merge"], kind: "write" },
  { path: ["status"], kind: "read" },
  { path: ["mode", "night"], kind: "write" },
  { path: ["mode", "watch"], kind: "write" },
  { path: ["mode", "off"], kind: "write" },
  { path: ["mode", "status"], kind: "read" },
  { path: ["audit", "skills"], kind: "read" },
  { path: ["inbox", "list"], kind: "read" },
  { path: ["inbox", "count"], kind: "read" },
  { path: ["inbox", "done"], kind: "write" },
  { path: ["decision", "add"], kind: "write", fileFlags: ["--body-file"] },
  { path: ["decision", "list"], kind: "read" },
  { path: ["decision", "set"], kind: "write" },
  { path: ["decision", "migrate"], kind: "write" },
  { path: ["journal", "append"], kind: "write", fileFlags: ["--file"] },
  { path: ["journal", "get"], kind: "read" },
  { path: ["kb", "commit"], kind: "write" },
  { path: ["kb", "maintain"], kind: "write" },
  { path: ["kb", "get"], kind: "read" },
  { path: ["kb", "search"], kind: "read" },
  { path: ["kb", "check"], kind: "read" },
  { path: ["session", "register"], kind: "write" },
  { path: ["session", "name"], kind: "read" },
];

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

/** Konsol exec alt süreç sınırı: kapı komutları uzak çağrılarını (gate 30 dk, merge 330 sn) kapsar; diğerleri 110 sn. */
export function consoleExecTimeoutMs(argv: string[]): number {
  if (argv[0] === "task" && argv[1] === "gate") return 31 * 60_000;
  if (argv[0] === "task" && argv[1] === "merge") return 6 * 60_000;
  return 110_000;
}
