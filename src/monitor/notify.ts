import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NtfyChannel } from "../approver/ntfy.js";
import type { ChannelConfig } from "../approver/types.js";
import { MONITOR_SERVER_ID_RE } from "./types.js";
import { monitorStateDir } from "./state.js";

/**
 * Anında haber kuyruğu (plan Karar 1): monitor durum dizini altındaki `notify/` klasöründe olay başına bir JSON dosyası (0700/0600,
 * tmp+rename, belirleyici ad `<server>__<kind>__<task>[__<trigger>].json` → idempotent). İçerik yalnız kimlik/metaveri; ajan metni (alarm başlığı) girmez.
 * Okundu = dosyayı `notify/done/` altına taşımak. Okuma tarafı hata yutar (bozuk dosya atlanır); kb'ye dokunulmaz.
 */
export type NoticeKind = "alert" | "capacity";
export interface Notice { ts: number; kind: NoticeKind; server: string; task: string; trigger?: string }
export interface StoredNotice extends Notice { v: 1; id: string }

const ID_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const defaultNotifyDir = (home?: string): string => join(monitorStateDir(home), "notify");

function nameOf(n: Notice): string {
  if (!MONITOR_SERVER_ID_RE.test(n.server) || !ID_PART.test(n.task) || (n.kind !== "alert" && n.kind !== "capacity")) throw new Error("bildirim kimliği geçersiz");
  if (n.trigger !== undefined && !ID_PART.test(n.trigger)) throw new Error("bildirim tetikleyici kimliği geçersiz");
  return [n.server, n.kind, n.task, ...(n.trigger ? [n.trigger] : [])].join("__");
}

export function enqueueNotice(dir: string, n: Notice): string {
  const id = nameOf(n);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  const rec = { v: 1, ts: n.ts, kind: n.kind, server: n.server, task: n.task, ...(n.trigger ? { trigger: n.trigger } : {}) };
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return id;
}

function parse(dir: string, f: string): StoredNotice | null {
  if (!f.endsWith(".json")) return null;
  try {
    const o = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    if (o.v !== 1 || typeof o.ts !== "number" || (o.kind !== "alert" && o.kind !== "capacity") || typeof o.server !== "string" || typeof o.task !== "string") return null;
    if (o.trigger !== undefined && typeof o.trigger !== "string") return null;
    const n: Notice = { ts: o.ts, kind: o.kind, server: o.server, task: o.task, ...(typeof o.trigger === "string" ? { trigger: o.trigger } : {}) };
    const id = nameOf(n);
    if (`${id}.json` !== f) return null; // ad içerikle uyuşmuyor: yabancı dosya
    return { v: 1, id, ...n };
  } catch { return null; }
}

export function listNotices(dir: string, o: { limit?: number } = {}): StoredNotice[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const all = names.flatMap((f) => { const s = parse(dir, f); return s ? [s] : []; }).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  return o.limit === undefined ? all : all.slice(0, o.limit);
}
export const countNotices = (dir: string): number => listNotices(dir).length;

/** `id` ya da `"all"`; taşınan sayıyı döner. Geçersiz kimlik (yol geçişi) fırlatır. */
export function markDone(dir: string, id: string): number {
  const ids = id === "all" ? listNotices(dir).map((x) => x.id) : [id];
  let moved = 0;
  for (const i of ids) {
    if (!/^[A-Za-z0-9._-]+(__[A-Za-z0-9._-]+)+$/.test(i) || i.includes("..")) throw new Error(`geçersiz bildirim kimliği: ${i}`);
    const src = join(dir, `${i}.json`);
    if (!existsSync(src)) continue;
    mkdirSync(join(dir, "done"), { recursive: true, mode: 0o700 });
    renameSync(src, join(dir, "done", `${i}.json`));
    moved++;
  }
  return moved;
}

/** `pull`/`capacity` bildirimcisi: kuyruk dosyası asıl kayıt, ntfy en iyi çaba (kanal yok/ağ hatası fırlatmaz). */
export interface Notifier {
  notice(n: Notice): Promise<void>;
  /** `defer` kipinde biriken ntfy gönderimlerini eşzamanlı yapar (toplam süre tek zaman aşımı kadar); boşsa hemen döner. */
  flush?(): Promise<void>;
}
export function createNotifier(o: { dir?: string; channel: () => ChannelConfig | null; fetch?: typeof fetch; log?: (l: string) => void; defer?: boolean }): Notifier {
  const dir = o.dir ?? defaultNotifyDir();
  const log = o.log ?? (() => {});
  const pending: (() => Promise<void>)[] = [];
  const send = async (n: Notice): Promise<void> => {
    try {
      const cfg = o.channel();
      if (!cfg) return;
      const title = n.kind === "capacity" ? "VLAD kapasite" : "VLAD görev açtı";
      await new NtfyChannel(cfg, o.fetch).publishNotice({ title, message: `${n.server}: ${n.task}${n.trigger ? ` (${n.trigger})` : ""}` });
    } catch (e) { log(`ntfy bildirimi gönderilemedi: ${(e as Error).name}`); }
  };
  return {
    async notice(n) {
      try { enqueueNotice(dir, n); } catch (e) { log(`bildirim kuyruğa yazılamadı: ${(e as Error).message}`); }
      if (o.defer) pending.push(() => send(n)); else await send(n);
    },
    async flush() {
      const jobs = pending.splice(0);
      await Promise.all(jobs.map((j) => j())); // send hata fırlatmaz; eşzamanlı → toplam ≈ tek zaman aşımı
    },
  };
}
