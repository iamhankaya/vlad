import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "../kb/atomic.js";
import { kbPaths } from "../kb/home.js";
import type { GateRunResult } from "../fleet/types.js";

// `vlad task gate --compare-base` (F-vlad-290): görev kırmızısını hedef dalın (master ya da vlad/<çatı>) aynı makinedeki gate sonucuyla
// karşılaştırır; yalnız tabanda yeşil olup görevde kırmızı olan testler "yeni kırmızı" sayılır (D-genel-016).

/** Test adı ayrıştırılamayan kırmızı (derleme hatası, zaman aşımı): yeşil sanılmasın diye newRed'e bu işaret girer. */
export const UNPARSED_RED = "(gate kırmızı, test adı ayrıştırılamadı)";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** vitest çıktısındaki `FAIL <dosya> > <test>` satırlarından kırmızı test adları (ANSI ve süre soneki atılır, tekrarsız). */
export function parseRedTests(out: string): string[] {
  const seen = new Set<string>();
  for (const line of out.replace(ANSI, "").split(/\r?\n/)) {
    const m = /^\s*FAIL\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    seen.add(m[1]!.replace(/\s+\d+(\.\d+)?m?s$/, ""));
  }
  return [...seen];
}

/**
 * Kırmızı adlar tam mı: vitest özetinde "Tests N failed" ayrıştırılan test adı sayısıyla tutmalı; özet yoksa (lint/tsc adımı,
 * --bail kesintisi) ya da Unhandled Errors varsa adlar kırmızının tamamı sayılmaz (yeşil sanılmasın).
 */
export function redNamesComplete(out: string): boolean {
  const text = out.replace(ANSI, "");
  if (/Unhandled (Errors|Rejection)/i.test(text)) return false;
  if (!/^\s*Tests?\s+/m.test(text)) return false;
  const failed = Number(/^\s*Tests\s+(\d+) failed/m.exec(text)?.[1] ?? 0);
  return failed === parseRedTests(text).filter((n) => n.includes(" > ")).length;
}

/** Önbellekteki taban sonucu: head = tabanın koştuğu commit. */
export interface BaseEntry { head: string; exit: number; red: string[]; at: string }

export interface CompareDeps {
  runTask: () => Promise<GateRunResult>;
  /** İşçide taban koşusu; cachedHead dal ucuyla aynıysa işçi koşmadan `cached: true` döner (bayat önbellek yanlış yeşil vermesin). */
  runBase: (cachedHead?: string) => Promise<GateRunResult>;
  readCache: () => BaseEntry | null;
  writeCache: (e: BaseEntry) => void;
  now?: () => Date;
}

export interface CompareResult {
  /** karşılaştırmalı çıkış kodu: yeni kırmızı yoksa 0 */
  exit: number;
  /** görev gate'inin ham çıkış kodu */
  gateExit: number;
  task: GateRunResult;
  newRed: string[];
  baselineRed: string[];
  baselineSha: string | null;
  baselineCached: boolean;
}

export async function compareBase(d: CompareDeps): Promise<CompareResult> {
  const task = await d.runTask();
  if (task.exit === 0) return { exit: 0, gateExit: 0, task, newRed: [], baselineRed: [], baselineSha: null, baselineCached: false };
  const taskOut = `${task.stdout}\n${task.stderr}`;
  const taskRed = parseRedTests(taskOut);
  const cache = d.readCache();
  const b = await d.runBase(cache?.head);
  if (!b.head) throw new Error("taban gate sonucunda head yok; karşılaştırma yapılamadı");
  let entry: BaseEntry;
  let cached = false;
  if (b.cached) {
    if (!cache || cache.head !== b.head) throw new Error("işçi önbellekli taban döndü ama yerel önbellek eşleşmiyor");
    entry = cache; cached = true;
  } else {
    entry = { head: b.head, exit: b.exit, red: b.exit === 0 ? [] : parseRedTests(`${b.stdout}\n${b.stderr}`), at: (d.now?.() ?? new Date()).toISOString() };
    d.writeCache(entry);
  }
  const baseSet = new Set(entry.red);
  const newRed = taskRed.filter((t) => !baseSet.has(t));
  if (!redNamesComplete(taskOut)) newRed.push(UNPARSED_RED);
  return { exit: newRed.length ? 1 : 0, gateExit: task.exit, task, newRed, baselineRed: entry.red, baselineSha: entry.head, baselineCached: cached };
}

const cachePath = () => join(kbPaths().logs, "gate-base.json");
// gate komutu anahtarda: kart gate'i değişince eski komutun taban kırmızısı yeni komutla karşılaştırılmasın
const keyOf = (machine: string, project: string, branch: string, gate: string) => `${machine}|${project}|${branch}|${createHash("sha256").update(gate).digest("hex").slice(0, 12)}`;

/** Taban önbelleği (`kb/logs/gate-base.json`, git dışı): makine+proje+hedef dal+gate komutu başına son taban koşusu. Okuma/yazma en iyi çabadır. */
export function fileBaseCache(machine: string, project: string, branch: string, gate: string): Pick<CompareDeps, "readCache" | "writeCache"> {
  const read = (): Record<string, BaseEntry> => {
    try { return existsSync(cachePath()) ? JSON.parse(readFileSync(cachePath(), "utf8")) as Record<string, BaseEntry> : {}; } catch { return {}; }
  };
  return {
    readCache: () => {
      const e = read()[keyOf(machine, project, branch, gate)];
      return e && typeof e.head === "string" && /^[0-9a-f]{40}$/.test(e.head) && Array.isArray(e.red) ? e : null;
    },
    writeCache: (e) => {
      try {
        mkdirSync(kbPaths().logs, { recursive: true });
        writeFileAtomic(cachePath(), JSON.stringify({ ...read(), [keyOf(machine, project, branch, gate)]: e }, null, 1) + "\n");
      } catch { /* önbellek bir iyileştirme; yazılamazsa bir sonraki koşu tabanı yeniden koşar */ }
    },
  };
}
