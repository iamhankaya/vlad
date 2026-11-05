import { randomBytes, createHash } from "node:crypto";
import { open, lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { RemoteError, type RemoteTransport } from "../machines/types.js";
import { uniqueName } from "./paths.js";
import {
  XFER_MAX_ENTRIES, XFER_MAX_TOTAL_BYTES,
  type XferBeginResult, type XferCommitResult, type XferEntry, type XferItem, type XferPurpose,
} from "./types.js";

// Gönderici (plan T20261105-04 §A2). Kimlik (id) bir kez üretilir ve ömrü boyunca sabit kalır: hiçbir yolda yeni id ile baştan başlanmaz,
// belirsiz sonuç XferUncertainError olarak kullanıcıya bildirilir. Akış: ping caps → xfer-begin → xfer-chunk… → xfer-commit.
export class XferUncertainError extends RemoteError {
  constructor(message: string, public details: { planned?: string[]; published?: string[] } = {}) { super("uncertain", message); this.name = "XferUncertainError"; }
}
export interface SendOptions {
  to: string; paths: string[];
  onProgress?(p: { sentBytes: number; totalBytes: number; file: string }): void;
  chunkBytes?: number;
  /** shortcut: şimdilik yok sayılır (hep 1 uçuşta parça); alıcı offset sırası ister, paralel parça için aynı dosyada sıra garantisi gerekir. */
  concurrency?: 1 | 2;
  sleep?(ms: number): Promise<void>; newId?(): string;
}
export interface SendResult { to: string; items: XferItem[]; failed?: { name: string; error: string }; skipped: { path: string; reason: "symlink" | "special" }[]; totalBytes: number }

const CHUNK_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 10_000;
const ABORT_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [200, 800]; // 3 deneme
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fail = (msg: string) => new RemoteError("failed", `failed: ${msg}`);
const changed = () => fail("dosya gönderim sırasında değişti");

/** Parçaları sırayla `emit`'e verir (offset artan), dosyanın SHA-256'sını döner; dizin için null. */
type Feed = (i: number, chunkBytes: number, emit: (offset: number, data: Buffer) => Promise<void>) => Promise<string | null>;

interface Job {
  to: string; id: string; purpose: XferPurpose; entries: XferEntry[]; meta?: Record<string, string | number>;
  feed: Feed; chunkBytes?: number; sleep: (ms: number) => Promise<void>; onProgress?: SendOptions["onProgress"]; totalBytes: number;
}

/** Geçici hatada 200/800 ms arayla en çok 3 deneme. `track.timedOut`: bir deneme yanıtsız kaldı (istek işlenmiş olabilir). */
async function retry<T>(fn: () => Promise<T>, sleep: Job["sleep"], track?: { timedOut: boolean }): Promise<T> {
  for (let n = 0; ; n++) {
    try { return await fn(); } catch (e) {
      if (track && e instanceof RemoteError && e.code === "timeout") track.timedOut = true;
      if (!(e instanceof RemoteError) || !e.transient || n >= RETRY_DELAYS_MS.length) throw e;
      await sleep(RETRY_DELAYS_MS[n]!);
    }
  }
}

async function transfer(t: RemoteTransport, j: Job): Promise<XferCommitResult> {
  const call = <T>(op: Parameters<RemoteTransport["call"]>[1], args: unknown, track?: { timedOut: boolean }) =>
    retry(() => t.call<T>(j.to, op, args, { timeoutMs: CHUNK_TIMEOUT_MS }).then((r) => r.result), j.sleep, track);
  const begin = () => call<XferBeginResult>("xfer-begin", { id: j.id, purpose: j.purpose, entries: j.entries, ...(j.meta ? { meta: j.meta } : {}) });

  let b = await begin();
  if (b.state === "committed" && b.items) return { items: b.items };
  try {
    let shas: (string | null)[];
    for (let round = 0; ; round++) {
      const cb = Math.min(j.chunkBytes ?? b.chunkBytes, b.chunkBytes);
      const got = b.received;
      let pos = 0;
      try {
        shas = [];
        for (const [i, e] of j.entries.entries()) {
          const have = got?.[i] ?? 0;
          shas.push(await j.feed(i, cb, async (offset, data) => {
            if (offset + data.length <= have) { pos += data.length; return; } // alıcıda zaten var
            await call("xfer-chunk", { id: j.id, entry: i, offset, data: data.toString("base64") });
            pos += data.length;
            j.onProgress?.({ sentBytes: pos, totalBytes: j.totalBytes, file: e.path });
          }));
        }
        break;
      } catch (e) {
        // alıcı aktarımı unuttu (yeniden başlama/boşta süpürme): AYNI id ile begin tekrarı, en çok bir kez
        if (round === 0 && e instanceof RemoteError && e.code === "not_found") { b = await begin(); continue; }
        throw e;
      }
    }
    const track = { timedOut: false };
    try { return await call<XferCommitResult>("xfer-commit", { id: j.id, sha256: shas }, track); } catch (e) {
      if (e instanceof RemoteError && (e.code === "uncertain" || (track.timedOut && e.transient)))
        throw new XferUncertainError(e.code === "uncertain" ? e.message : "uncertain: teslim sonucu belirsiz; İndirilenler'e bak");
      throw e;
    }
  } catch (e) {
    // kalıcı hata: alıcıdaki hazırlığı bırak (geçici hata/belirsizlik/not_found'da bırakılmaz: alıcı kendi süpürür)
    const keep = e instanceof RemoteError && (e.transient || e.code === "not_found" || e.code === "uncertain");
    if (!keep) await t.call(j.to, "xfer-abort", { id: j.id }, { timeoutMs: ABORT_TIMEOUT_MS }).catch(() => {});
    throw e;
  }
}

/** Dosyayı `size` bayta kadar okur; tür/boyut/mtime gönderim boyunca değişirse hata (lstat sonrası açılan tanıtıcı fstat ile yeniden doğrulanır). */
async function feedFile(abs: string, size: number, chunkBytes: number, emit: (offset: number, data: Buffer) => Promise<void>): Promise<string> {
  const fh = await open(abs, "r");
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size !== size) throw changed();
    const h = createHash("sha256");
    for (let off = 0; off < size;) {
      const buf = Buffer.alloc(Math.min(chunkBytes, size - off));
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, off + got);
        if (bytesRead === 0) throw changed();
        got += bytesRead;
      }
      h.update(buf);
      await emit(off, buf);
      off += buf.length;
    }
    const end = await fh.stat();
    if (end.size !== st.size || end.mtimeMs !== st.mtimeMs) throw changed();
    return h.digest("hex");
  } finally { await fh.close(); }
}

interface Planned extends XferEntry { abs: string }

async function plan(paths: string[]): Promise<{ entries: Planned[]; skipped: SendResult["skipped"] }> {
  const entries: Planned[] = [], skipped: SendResult["skipped"] = [];
  const used = new Set<string>(); // üst düzey adlar, harf duyarsız
  const walk = async (abs: string, rel: string): Promise<number> => {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) { skipped.push({ path: abs, reason: "symlink" }); return 0; }
    if (st.isFile()) { entries.push({ path: rel, kind: "file", size: st.size, abs }); return 1; }
    if (!st.isDirectory()) { skipped.push({ path: abs, reason: "special" }); return 0; }
    let n = 0;
    for (const name of (await readdir(abs)).sort()) n += await walk(join(abs, name), `${rel}/${name}`);
    if (n === 0) { entries.push({ path: rel, kind: "dir", size: 0, abs }); n = 1; } // içinde gönderilecek bir şey yoksa boş dizin olarak
    return n;
  };
  for (const p of paths) {
    let st;
    try { st = await lstat(p); } catch { throw fail(`yol yok: ${p}`); }
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) { skipped.push({ path: p, reason: st.isSymbolicLink() ? "symlink" : "special" }); continue; }
    const name = await uniqueName(basename(p), async (c) => used.has(c.toLowerCase()), st.isDirectory() ? "dir" : "file");
    used.add(name.toLowerCase());
    await walk(p, name);
  }
  if (entries.length === 0) throw fail("gönderilecek bir şey yok (sembolik bağ ve özel dosyalar atlanır)");
  return { entries, skipped };
}

export async function sendPaths(t: RemoteTransport, o: SendOptions): Promise<SendResult> {
  const sleep = o.sleep ?? realSleep;
  const { entries, skipped } = await plan(o.paths);
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  if (totalBytes > XFER_MAX_TOTAL_BYTES) throw new RemoteError("too_large", "too_large: aktarım 4 GiB sınırını aşıyor");
  if (entries.length > XFER_MAX_ENTRIES) throw new RemoteError("too_large", `too_large: aktarım ${XFER_MAX_ENTRIES} öğe sınırını aşıyor`);

  const ping = await retry(() => t.call<{ caps?: unknown }>(o.to, "ping", {}, { timeoutMs: PING_TIMEOUT_MS }).then((r) => r.result), sleep);
  if (!Array.isArray(ping?.caps) || !ping.caps.includes("xfer")) throw fail("karşı Agent güncel değil (xfer yok); yeniden başlat");

  const r = await transfer(t, {
    to: o.to, id: (o.newId ?? (() => randomBytes(16).toString("hex")))(), purpose: "file", sleep, onProgress: o.onProgress, totalBytes, chunkBytes: o.chunkBytes,
    entries: entries.map(({ path, kind, size }) => ({ path, kind, size })),
    feed: async (i, cb, emit) => (entries[i]!.kind === "dir" ? null : feedFile(entries[i]!.abs, entries[i]!.size, cb, emit)),
  });
  return { to: o.to, items: r.items, ...(r.failed ? { failed: r.failed } : {}), skipped, totalBytes };
}

/** Bellekteki veriyi tek dosya olarak yükler (pano resmi). ping yapmaz: eski Agent op'u `forbidden` ile reddeder. */
export function uploadBuffer(t: RemoteTransport, to: string, data: Buffer, o: { purpose: XferPurpose; name: string; meta?: Record<string, string | number> }): Promise<XferCommitResult> {
  return transfer(t, {
    to, id: randomBytes(16).toString("hex"), purpose: o.purpose, meta: o.meta, sleep: realSleep, totalBytes: data.length,
    entries: [{ path: o.name, kind: "file", size: data.length }],
    feed: async (_i, cb, emit) => {
      for (let off = 0; off < data.length; off += cb) await emit(off, data.subarray(off, off + cb));
      return createHash("sha256").update(data).digest("hex");
    },
  });
}
