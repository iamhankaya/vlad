import { createHash, type Hash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { OpHandler } from "../agent/ops/index.js";
import { CLIP_MAX_IMAGE_BYTES, CLIP_MAX_PIXELS } from "../clip/types.js";
import { RemoteError } from "../machines/types.js";
import { createLedger } from "./ledger.js";
import { isXferId, sanitizeEntryPath, uniqueName } from "./paths.js";
import {
  XFER_CHUNK_BYTES, XFER_IDLE_MS, XFER_MAX_ACTIVE, XFER_MAX_ENTRIES, XFER_MAX_TOTAL_BYTES, XFER_MIN_FREE_BYTES, XFER_STAGING_DIR, XFER_STAGING_QUOTA_BYTES, XFER_STALE_MS,
  type XferBeginResult, type XferChunkResult, type XferCommitResult, type XferDeps, type XferEntry, type XferFs, type XferItem, type XferPurpose, type XferReceiver,
} from "./types.js";

// Alıcı: tek yetkili. Gönderenin yolu/boyutu/kimliği doğrulanır; kullanıcı dizinine yalnız commit'te, öğe başına atomik yayımlanır.
// Anahtar = ctx.from + "\0" + id (from HMAC doğrulamalı). Durumlar: receiving → committing → committed | aborted.
export type { XferReceiver } from "./types.js";

const err = (code: "bad_request" | "conflict" | "not_found" | "too_large" | "busy" | "failed" | "uncertain", m: string) => new RemoteError(code, `${code}: ${m}`);
const badManifest = (why: string) => err("bad_request", `manifest geçersiz: ${why}`);
const UNCERTAIN = () => err("uncertain", "teslim sonucu belirsiz; İndirilenler'e bak");
const SHA_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function mapFs(e: unknown): never {
  if (e instanceof RemoteError) throw e;
  const c = (e as NodeJS.ErrnoException).code;
  if (c === "EPERM" || c === "EACCES") throw err("failed", "İndirilenler erişimi reddedildi (macOS Gizlilik: Dosyalar ve Klasörler)");
  if (c === "ENOSPC" || c === "EDQUOT") throw err("too_large", "boş alan yetersiz");
  throw err("failed", c ?? (e as Error).message);
}
const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

interface FileState { received: number; hash: Hash; file: string }
interface Xfer {
  key: string; from: string; id: string; purpose: XferPurpose; entries: XferEntry[]; parts: string[][]; meta?: Record<string, string | number>;
  manifestHash: string; total: number; stage: string; tree: string; state: "receiving" | "committing";
  files: Map<number, FileState>; lastActive: number; chain: Promise<unknown>; timer?: NodeJS.Timeout;
}
interface Meta { from: string; id: string; manifestHash: string; state: string; createdAt: number }

function validateManifest(a: Record<string, unknown>, os: XferDeps["os"]): { purpose: XferPurpose; entries: XferEntry[]; parts: string[][]; meta?: Record<string, string | number>; total: number } {
  const purpose = a.purpose;
  if (purpose !== "file" && purpose !== "clip-image") throw badManifest("amaç bilinmiyor");
  const raw = a.entries;
  if (!Array.isArray(raw) || raw.length === 0) throw badManifest("öğe listesi boş veya dizi değil");
  if (raw.length > XFER_MAX_ENTRIES) throw badManifest(`en çok ${XFER_MAX_ENTRIES} öğe`);
  let meta: Record<string, string | number> | undefined;
  if (a.meta !== undefined) {
    if (!isObj(a.meta)) throw badManifest("meta nesne değil");
    for (const v of Object.values(a.meta)) if (typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v))) throw badManifest("meta değeri metin veya sayı olmalı");
    meta = a.meta as Record<string, string | number>;
  }
  const entries: XferEntry[] = [], parts: string[][] = [];
  const full = new Map<string, number>(), canon = new Map<string, string>(), dirs = new Set<string>();
  let total = 0;
  for (const e of raw) {
    if (!isObj(e) || typeof e.path !== "string" || (e.kind !== "file" && e.kind !== "dir") || !isInt(e.size)) throw badManifest("öğe biçimi bozuk");
    if (e.kind === "dir" && e.size !== 0) throw badManifest("dizin boyutu 0 olmalı");
    const p = sanitizeEntryPath(e.path, os);
    const lc = p.join("/").toLowerCase();
    if (full.has(lc)) throw badManifest(`aynı yol iki kez: ${e.path}`);
    full.set(lc, entries.length);
    for (let i = 1; i <= p.length; i++) {
      const pre = p.slice(0, i), key = pre.join("/").toLowerCase(), exact = pre.join("/");
      const seen = canon.get(key);
      if (seen !== undefined && seen !== exact) throw badManifest(`harf duyarlılığı çakışıyor: ${exact}`);
      canon.set(key, exact);
      if (i < p.length) dirs.add(key);
    }
    total += e.size;
    entries.push({ path: e.path, kind: e.kind, size: e.size }); parts.push(p);
  }
  for (const k of dirs) if (full.has(k)) throw badManifest(`dosya ile dizin çakışıyor: ${k}`);
  if (total > XFER_MAX_TOTAL_BYTES) throw err("too_large", "aktarım 4 GiB sınırını aşıyor");
  if (purpose === "clip-image") {
    if (entries.length !== 1 || entries[0]!.kind !== "file" || parts[0]!.join("/") !== "clip.png") throw badManifest("clip-image tek clip.png dosyası olmalı");
    if (entries[0]!.size > CLIP_MAX_IMAGE_BYTES) throw badManifest("resim çok büyük");
    if (!meta || typeof meta.eventTs !== "number" || (meta.rank !== 0 && meta.rank !== 1)) throw badManifest("clip-image meta eventTs ve rank ister");
  }
  return { purpose, entries, parts, ...(meta ? { meta } : {}), total };
}

const pngDims = (b: Buffer): [number, number] | null => {
  if (b.length < 24 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

export function createXferReceiver(d: XferDeps): XferReceiver {
  const fs: XferFs = { statfs: (p) => fsp.statfs(p) as Promise<{ bavail: number; bsize: number }>, link: fsp.link, rename: fsp.rename, copyFile: fsp.copyFile, ...d.fs };
  const ledger = createLedger(d.stateDir());
  const active = new Map<string, Xfer>();
  const incoming = () => path.join(d.downloads(), XFER_STAGING_DIR);
  let beginChain: Promise<unknown> = Promise.resolve();
  let closed = false;

  const lock = <T>(x: { chain: Promise<unknown> }, fn: () => Promise<T>): Promise<T> => {
    const run = x.chain.then(fn, fn);
    x.chain = run.catch(() => {});
    return run;
  };
  const reserved = () => { let n = 0; for (const x of active.values()) n += x.total; return n; };

  const assertRealDir = async (p: string) => {
    const st = await fsp.lstat(p);
    if (!st.isDirectory() || st.isSymbolicLink()) throw err("failed", "hazırlık klasörü güvenli değil");
  };
  const dirBytes = async (dir: string): Promise<number> => {
    let n = 0;
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) n += await dirBytes(p); else if (e.isFile()) n += (await fsp.lstat(p).catch(() => null))?.size ?? 0;
    }
    return n;
  };
  const orphanBytes = async (): Promise<number> => {
    let n = 0;
    for (const e of await fsp.readdir(incoming(), { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !isXferId(e.name) || [...active.values()].some((x) => x.id === e.name)) continue;
      n += await dirBytes(path.join(incoming(), e.name));
    }
    return n;
  };
  const rmStage = (stage: string) => fsp.rm(stage, { recursive: true, force: true }).catch(() => {});

  const forget = async (x: Xfer) => {
    if (x.timer) clearTimeout(x.timer);
    if (active.get(x.key) === x) active.delete(x.key);
    await rmStage(x.stage);
  };
  const armTimer = (x: Xfer) => {
    if (d.idleTimers === false || closed) return;
    if (x.timer) clearTimeout(x.timer);
    x.timer = setTimeout(() => { void expireIdle(); }, XFER_IDLE_MS + 50);
    x.timer.unref();
  };
  const touch = (x: Xfer) => { x.lastActive = d.now(); armTimer(x); };

  async function abortX(x: Xfer, record = true): Promise<void> {
    await forget(x);
    if (record) { const r = await ledger.get(x.key).catch(() => undefined); if (!r) await ledger.put(x.key, { state: "aborted" }).catch(() => {}); }
  }
  async function expireIdle(): Promise<number> {
    let n = 0;
    for (const x of [...active.values()]) {
      if (x.state !== "receiving" || d.now() - x.lastActive < XFER_IDLE_MS) continue;
      await lock(x, async () => { if (active.get(x.key) === x && x.state === "receiving" && d.now() - x.lastActive >= XFER_IDLE_MS) { await abortX(x); n++; } });
    }
    return n;
  }

  const readMeta = async (stage: string): Promise<Meta | null> => {
    try { const m = JSON.parse(await fsp.readFile(path.join(stage, "meta.json"), "utf8")) as Meta; return isObj(m) ? m : null; } catch { return null; }
  };

  const begin: OpHandler = async (args, ctx) => {
    if (!isObj(args) || !isXferId(args.id)) throw err("bad_request", "aktarım kimliği geçersiz");
    const id = args.id, from = ctx.from, key = `${from}\0${id}`;
    const m = validateManifest(args, d.os);
    if (m.purpose === "clip-image" && !(d.clipImage && d.clipImage.enabled())) throw err("failed", "pano kapalı veya desteklenmiyor");
    const manifestHash = createHash("sha256").update(canonicalJson({ purpose: m.purpose, meta: m.meta ?? null, entries: m.entries })).digest("hex");
    const run = beginChain.then(() => doBegin(), () => doBegin());
    beginChain = run.catch(() => {});
    return run;

    async function doBegin(): Promise<XferBeginResult> {
      await expireIdle();
      for (const o of active.values()) if (o.id === id && o.from !== from) throw err("conflict", "aktarım kimliği başka bir istekle kullanılmış");
      const ex = active.get(key);
      if (ex) {
        if (ex.manifestHash !== manifestHash) throw err("conflict", "aktarım kimliği başka bir istekle kullanılmış");
        if (ex.state === "committing") throw err("busy", "aktarım tamamlanıyor");
        touch(ex);
        return { id, chunkBytes: XFER_CHUNK_BYTES, state: "receiving", received: m.entries.map((_, i) => ex.files.get(i)?.received ?? 0) };
      }
      const rec = await ledger.get(key);
      if (rec?.state === "committed") return { id, chunkBytes: XFER_CHUNK_BYTES, state: "committed", items: rec.items };
      if (rec?.state === "committing") throw UNCERTAIN();
      if ([...active.values()].filter((o) => o.state === "receiving" || o.state === "committing").length >= XFER_MAX_ACTIVE) throw err("busy", "çok fazla etkin aktarım");

      const stage = path.join(incoming(), id);
      try {
        await fsp.mkdir(d.downloads(), { recursive: true });
        await fsp.mkdir(incoming(), { recursive: true, mode: 0o700 });
        await assertRealDir(incoming());
        const old = await readMeta(stage).catch(() => null);
        const present = await fsp.lstat(stage).then(() => true, () => false);
        if (present) {
          if (!old) throw err("failed", "hazırlık klasörü kullanımda");
          if (old.from !== from || old.manifestHash !== manifestHash) throw err("conflict", "aktarım kimliği başka bir istekle kullanılmış");
          await assertRealDir(stage);
          await rmStage(stage); // yeniden başlama: dosyalar sıfırlanır, aynı id ile yeniden başlar
        }
        const orphans = await orphanBytes();
        if (orphans + reserved() + m.total > XFER_STAGING_QUOTA_BYTES) throw err("too_large", "hazırlık kotası dolu");
        const st = await fs.statfs(d.downloads());
        if (st.bavail * st.bsize - reserved() - m.total < XFER_MIN_FREE_BYTES) throw err("too_large", "boş alan yetersiz");

        await fsp.mkdir(stage, { mode: 0o700 });
        const tree = path.join(stage, "tree");
        await fsp.mkdir(tree);
        const meta: Meta = { from, id, manifestHash, state: "receiving", createdAt: d.now() };
        await fsp.writeFile(path.join(stage, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
        const x: Xfer = { key, from, id, purpose: m.purpose, entries: m.entries, parts: m.parts, ...(m.meta ? { meta: m.meta } : {}), manifestHash, total: m.total, stage, tree, state: "receiving", files: new Map(), lastActive: d.now(), chain: Promise.resolve() };
        for (let i = 0; i < m.entries.length; i++) {
          const p = path.resolve(tree, ...m.parts[i]!);
          if (!p.startsWith(tree + path.sep)) throw err("bad_request", "yol geçersiz: hazırlık dışına çıkıyor");
          if (m.entries[i]!.kind === "dir") { await fsp.mkdir(p, { recursive: true }); continue; }
          await fsp.mkdir(path.dirname(p), { recursive: true });
          await (await fsp.open(p, "wx")).close(); // O_EXCL
          x.files.set(i, { received: 0, hash: createHash("sha256"), file: p });
        }
        active.set(key, x);
        armTimer(x);
        return { id, chunkBytes: XFER_CHUNK_BYTES, state: "new" };
      } catch (e) {
        await rmStage(stage);
        return mapFs(e);
      }
    }
  };

  const find = (args: unknown, from: string): { a: Record<string, unknown>; id: string; key: string; x: Xfer | undefined } => {
    if (!isObj(args) || !isXferId(args.id)) throw err("bad_request", "aktarım kimliği geçersiz");
    const key = `${from}\0${args.id}`;
    return { a: args, id: args.id, key, x: active.get(key) };
  };

  const chunk: OpHandler = async (args, ctx): Promise<XferChunkResult> => {
    const { a, key, x } = find(args, ctx.from);
    if (!isInt(a.entry) || !isInt(a.offset) || typeof a.data !== "string") throw err("bad_request", "parça argümanları geçersiz");
    if (a.data.length > Math.ceil((XFER_CHUNK_BYTES * 4) / 3) + 4 || !B64_RE.test(a.data)) throw err("bad_request", "parça verisi geçersiz");
    const data = Buffer.from(a.data, "base64");
    if (data.length > XFER_CHUNK_BYTES) throw err("bad_request", "parça chunkBytes'tan büyük");
    if (!x) throw err("not_found", "aktarım bulunamadı");
    const entry = a.entry, offset = a.offset;
    return lock(x, async () => {
      if (active.get(key) !== x) throw err("not_found", "aktarım bulunamadı");
      if (x.state !== "receiving") throw err("busy", "aktarım tamamlanıyor");
      if (entry >= x.entries.length) throw err("bad_request", "parça argümanları geçersiz: öğe yok");
      const f = x.files.get(entry);
      if (!f) throw err("bad_request", "manifest geçersiz: dizin girdisine parça gönderilemez");
      try {
        if (offset === f.received) {
          if (f.received + data.length > x.entries[entry]!.size) throw err("bad_request", "boyut uyuşmuyor");
          if (data.length) {
            const fh = await fsp.open(f.file, "r+");
            try {
              let w = 0;
              while (w < data.length) { const { bytesWritten } = await fh.write(data, w, data.length - w, offset + w); w += bytesWritten; }
            } finally { await fh.close(); }
            f.hash.update(data);
            f.received += data.length;
          }
        } else if (offset + data.length <= f.received) {
          const fh = await fsp.open(f.file, "r");
          try {
            const buf = Buffer.alloc(data.length);
            const { bytesRead } = await fh.read(buf, 0, data.length, offset);
            if (bytesRead !== data.length || !buf.equals(data)) throw err("conflict", "parça sırası bozuk: aynı aralık farklı bayt");
          } finally { await fh.close(); }
        } else throw err("conflict", `parça sırası bozuk (alınan ${f.received})`);
        touch(x);
        await d.hooks?.afterChunk?.(x.id, offset);
      } catch (e) { return mapFs(e); }
      return { received: f.received };
    });
  };

  const readLedgerResult = async (key: string): Promise<XferCommitResult> => {
    const rec = await ledger.get(key);
    if (rec?.state === "committed") return { items: rec.items };
    if (rec?.state === "committing") throw UNCERTAIN();
    throw err("not_found", "aktarım bulunamadı");
  };

  const commit: OpHandler = async (args, ctx): Promise<XferCommitResult> => {
    const { a, key, x } = find(args, ctx.from);
    if (!Array.isArray(a.sha256)) throw err("bad_request", "sha256 dizisi geçersiz");
    const shas = a.sha256 as unknown[];
    if (!x) return readLedgerResult(key);
    if (shas.length !== x.entries.length || shas.some((s, i) => (x.entries[i]!.kind === "dir" ? s !== null : typeof s !== "string" || !SHA_RE.test(s.toLowerCase())))) throw err("bad_request", "sha256 dizisi geçersiz");
    return lock(x, async () => {
      if (active.get(key) !== x) return readLedgerResult(key);
      try { return await doCommit(x, shas as (string | null)[], ctx.from); } catch (e) {
        if (active.get(key) === x) { const keep = (await ledger.get(key).catch(() => undefined))?.state === "committing"; await forget(x); if (!keep) await ledger.put(key, { state: "aborted" }).catch(() => {}); }
        return mapFs(e);
      }
    });
  };

  async function doCommit(x: Xfer, shas: (string | null)[], from: string): Promise<XferCommitResult> {
    for (const [i, f] of x.files) {
      if (f.received !== x.entries[i]!.size) throw err("bad_request", "boyut uyuşmuyor");
      if (f.hash.copy().digest("hex") !== shas[i]!.toLowerCase()) throw err("bad_request", "boyut uyuşmuyor"); // sha256 uyuşmazlığı: aynı sabit metin
    }
    x.state = "committing";

    if (x.purpose === "clip-image") {
      const png = await fsp.readFile(x.files.get(0)!.file);
      const dims = pngDims(png);
      if (!dims || dims[0] < 1 || dims[1] < 1 || dims[0] * dims[1] > CLIP_MAX_PIXELS) throw err("bad_request", "resim geçersiz");
      const clip = await d.clipImage!.apply(png, { eventTs: x.meta!.eventTs as number, rank: x.meta!.rank as 0 | 1 }, from);
      await ledger.put(x.key, { state: "committed", items: [] });
      await forget(x);
      return { items: [], clip };
    }

    // üst düzey öğeler (ilk görünüş sırası)
    const tops: { name: string; kind: "file" | "dir"; size: number }[] = [];
    x.parts.forEach((p, i) => {
      let t = tops.find((o) => o.name === p[0]);
      if (!t) { t = { name: p[0]!, kind: p.length === 1 ? x.entries[i]!.kind : "dir", size: 0 }; tops.push(t); }
      t.size += x.entries[i]!.size;
    });
    await ledger.put(x.key, { state: "committing", planned: tops.map((t) => t.name), published: [] });
    const items: XferItem[] = [];
    let failed: { name: string; error: string } | undefined;
    for (const t of tops) {
      try {
        await d.hooks?.beforePublish?.(t.name);
        const target = await publish(path.join(x.tree, t.name), t.name, t.kind);
        items.push({ name: path.basename(target), kind: t.kind, size: t.size, path: target });
        await ledger.put(x.key, { state: "committing", planned: tops.map((o) => o.name), published: items.map((i) => i.path) });
      } catch (e) {
        try { mapFs(e); } catch (m) { failed = { name: t.name, error: (m as Error).message }; }
        break;
      }
    }
    if (failed && !items.length) { await ledger.put(x.key, { state: "aborted" }); throw err("failed", failed.error.replace(/^\w+: /, "")); }
    if (!failed) await ledger.put(x.key, { state: "committed", items }); // kısmi başarıda kayıt "committing" kalır: tekrar commit uncertain döner
    await forget(x);
    try {
      await d.notifier.notify(`${from}'den dosya geldi`, items.length === 1 ? items[0]!.name : `${items[0]!.name} ve ${items.length - 1} öğe daha (${items.length} öğe)`);
    } catch { /* bildirim teslimi bozmaz */ }
    return failed ? { items, failed } : { items };
  }

  /** Öğeyi İndirilenler'e atomik yayımlar; ad çakışmasında sonraki adı dener, hiçbir şeyi ezmez. */
  async function publish(staged: string, name: string, kind: "file" | "dir"): Promise<string> {
    const taken = new Set<string>();
    for (let attempt = 0; attempt < 200; attempt++) {
      const lc = new Set((await fsp.readdir(d.downloads())).map((n) => n.toLowerCase()));
      const cand = await uniqueName(name, async (c) => lc.has(c.toLowerCase()) || taken.has(c.toLowerCase()), kind);
      const target = path.join(d.downloads(), cand);
      try {
        if (kind === "file") {
          try { await fs.link(staged, target); } catch (e) {
            if (!["EXDEV", "ENOTSUP", "EPERM", "ENOSYS", "EOPNOTSUPP"].includes(errno(e) ?? "")) throw e;
            await fs.copyFile(staged, target, constants.COPYFILE_EXCL);
          }
          await fsp.unlink(staged).catch(() => {});
        } else if (d.os === "win32") {
          await fs.rename(staged, target);
        } else {
          await fsp.mkdir(target); // rezervasyon (EEXIST → sonraki ad)
          try { await fs.rename(staged, target); } catch (e) {
            if (errno(e) !== "ENOTEMPTY" && errno(e) !== "EEXIST") await fsp.rmdir(target).catch(() => {});
            throw e;
          }
        }
        return target;
      } catch (e) {
        if (["EEXIST", "ENOTEMPTY"].includes(errno(e) ?? "") || (d.os === "win32" && kind === "dir" && errno(e) === "EPERM")) { taken.add(cand.toLowerCase()); continue; }
        throw e;
      }
    }
    throw err("failed", `boş ad bulunamadı: ${name}`);
  }

  const abort: OpHandler = async (args, ctx) => {
    const { key, x } = find(args, ctx.from);
    if (x) await lock(x, async () => { if (active.get(key) === x && x.state === "receiving") await abortX(x); });
    return null;
  };

  async function sweep(): Promise<number> {
    let n = await expireIdle();
    const dir = incoming();
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.isSymbolicLink() || !isXferId(e.name) || [...active.values()].some((x) => x.id === e.name)) continue;
      const stage = path.join(dir, e.name);
      const meta = await readMeta(stage);
      if (!meta || typeof meta.createdAt !== "number" || d.now() - meta.createdAt <= XFER_STALE_MS) continue;
      await rmStage(stage); n++;
    }
    return n;
  }

  return {
    ops: { "xfer-begin": begin, "xfer-chunk": chunk, "xfer-commit": commit, "xfer-abort": abort },
    sweep,
    async close() { closed = true; for (const x of active.values()) if (x.timer) clearTimeout(x.timer); },
  };
}
