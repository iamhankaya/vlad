// aktarim-kabul: kabul testlerinin ortak yardımcıları. Yalnız sözleşmeye bakar (op imzaları, test/aktarim/harness.ts API'si,
// dosya sistemi gözlemi); uygulamanın içine bakmaz. Gerçek pano/bildirim/İndirilenler yok: her şey temp + sahte.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import { createClipReceiver } from "../../src/clip/receive.js";
import type { ClipContent, ClipDeps, ClipPushArgs, ClipReceiver } from "../../src/clip/types.js";
import { RemoteError, type Os, type RemoteTransport } from "../../src/fleet/types.js";
import { createXferReceiver } from "../../src/transfer/receive.js";
import {
  XFER_CHUNK_BYTES, XFER_STAGING_DIR,
  type ClipImageResult, type ClipImageSink, type XferBeginResult, type XferCommitResult, type XferDeps, type XferEntry, type XferPurpose, type XferReceiver,
} from "../../src/transfer/types.js";
import { FakeClipboard, FakeNotifier } from "../aktarim/harness.js";
import { rmTemp } from "../helpers.js";

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
export const newId = (): string => randomBytes(16).toString("hex");
export const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64");
export const bytes = (n: number, seed = 1): Buffer => {
  const b = Buffer.alloc(n); let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
  return b;
};

/** İndirilenler'in doğrudan çocukları (hazırlık klasörü hariç): kullanıcının gördüğü küme. */
export const visible = (dir: string): string[] => readdirSync(dir).filter((n) => n !== XFER_STAGING_DIR).sort();
/** dir altındaki her şeyin göreli yolu (dosya+dizin), `skip` ile başlayanlar hariç. */
export function listAll(dir: string, skip: string[] = []): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e), rel = relative(dir, p);
      if (skip.some((s) => rel === s || rel.startsWith(s + "/"))) continue;
      out.push(rel);
      if (lstatSync(p).isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}
export const read = (...p: string[]): Buffer => readFileSync(join(...p));
export const mkTemp = (prefix = "vlad-akt-k-"): string => mkdtempSync(join(tmpdir(), prefix));

// ---- ham yükleme (sendPaths'e bağımlı olmadan, protokolü doğrudan konuşur) ----
export interface RawFile { path: string; data: Buffer }
export interface RawDir { path: string; dir: true }
export type RawItem = RawFile | RawDir;
const isDir = (i: RawItem): i is RawDir => (i as RawDir).dir === true;
export const entriesOf = (items: RawItem[]): XferEntry[] => items.map((i) => (isDir(i) ? { path: i.path, kind: "dir" as const, size: 0 } : { path: i.path, kind: "file" as const, size: i.data.length }));
export const hashesOf = (items: RawItem[]): (string | null)[] => items.map((i) => (isDir(i) ? null : sha256(i.data)));

let opN = 0;
const opId = (tag: string) => `akt-k-${tag}-${process.pid}-${++opN}`;
export interface CallOpts { opId?: string; timeoutMs?: number; as?: string }
export const wire = <T = unknown>(t: RemoteTransport, to: string, op: Parameters<RemoteTransport["call"]>[1], args: unknown, o: CallOpts = {}) =>
  t.call<T>(to, op, args, { opId: o.opId ?? opId(op), timeoutMs: o.timeoutMs ?? 10_000, ...(o.as ? { as: o.as } : {}) }).then((r) => r.result);

export interface UploadOpts { id?: string; purpose?: XferPurpose; meta?: Record<string, string | number>; chunkBytes?: number; commit?: boolean; sha?: (string | null)[]; stopAfterChunks?: number }
/** begin → chunk… → commit. `commit:false` commit'ten önce durur (yarım aktarım). */
export async function rawUpload(t: RemoteTransport, to: string, items: RawItem[], o: UploadOpts = {}): Promise<{ id: string; begin: XferBeginResult; commit?: XferCommitResult }> {
  const id = o.id ?? newId();
  const begin = await wire<XferBeginResult>(t, to, "xfer-begin", { id, purpose: o.purpose ?? "file", entries: entriesOf(items), ...(o.meta ? { meta: o.meta } : {}) });
  const cb = Math.min(o.chunkBytes ?? XFER_CHUNK_BYTES, begin.chunkBytes);
  let sent = 0;
  for (const [entry, it] of items.entries()) {
    if (isDir(it)) continue;
    for (let off = 0; off < it.data.length; off += cb) {
      if (o.stopAfterChunks !== undefined && sent >= o.stopAfterChunks) return { id, begin };
      await wire(t, to, "xfer-chunk", { id, entry, offset: off, data: b64(it.data.subarray(off, off + cb)) });
      sent++;
    }
  }
  if (o.commit === false) return { id, begin };
  const commit = await wire<XferCommitResult>(t, to, "xfer-commit", { id, sha256: o.sha ?? hashesOf(items) });
  return { id, begin, commit };
}
/** Hata kodunu döndürür; hata yoksa "ok". */
export const STUB_RE = /henüz gerçeklenmedi/;
/** Uygulama yokken ("henüz gerçeklenmedi") "not-implemented" döner: kırmızı neden okunur olur ve hiçbir beklenen kodla eşleşmez. */
export const codeOf = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e) => {
  const msg = (e as Error).message ?? "";
  if (STUB_RE.test(msg)) return "not-implemented";
  return e instanceof RemoteError ? e.code : `non-remote:${msg}`;
});
export const messageOf = async (p: Promise<unknown>): Promise<string> => p.then(() => "", (e) => (e as Error).message);

// ---- süreç içi aktarım alıcısı (ağ yok; kancalar/sahte fs/sink için) ----
export interface LocalXfer {
  base: string; downloads: string; stateDir: string; notifier: FakeNotifier; recv: XferReceiver;
  call<T = unknown>(op: "xfer-begin" | "xfer-chunk" | "xfer-commit" | "xfer-abort", args: unknown, from?: string): Promise<T>;
  upload(items: RawItem[], o?: UploadOpts & { from?: string }): Promise<{ id: string; begin: XferBeginResult; commit?: XferCommitResult }>;
  stop(): void;
}
export function localXfer(o: { os?: Os; hooks?: XferDeps["hooks"]; fs?: XferDeps["fs"]; clipImage?: ClipImageSink; now?: () => number } = {}): LocalXfer {
  const base = mkTemp();
  const downloads = join(base, "Downloads"), stateDir = join(base, "state");
  mkdirSync(downloads, { recursive: true }); mkdirSync(stateDir, { recursive: true });
  const notifier = new FakeNotifier();
  const recv = createXferReceiver({ downloads: () => downloads, stateDir: () => stateDir, os: o.os ?? "darwin", notifier, now: o.now ?? (() => Date.now()), hooks: o.hooks, fs: o.fs, clipImage: o.clipImage, idleTimers: false });
  const call = <T,>(op: "xfer-begin" | "xfer-chunk" | "xfer-commit" | "xfer-abort", args: unknown, from = "windows") => recv.ops[op](args, { from, opId: randomUUID() }) as Promise<T>;
  const upload: LocalXfer["upload"] = async (items, u = {}) => {
    const id = u.id ?? newId(), from = u.from ?? "windows";
    const begin = await call<XferBeginResult>("xfer-begin", { id, purpose: u.purpose ?? "file", entries: entriesOf(items), ...(u.meta ? { meta: u.meta } : {}) }, from);
    const cb = Math.min(u.chunkBytes ?? XFER_CHUNK_BYTES, begin.chunkBytes);
    for (const [entry, it] of items.entries()) {
      if (isDir(it)) continue;
      for (let off = 0; off < it.data.length; off += cb) await call("xfer-chunk", { id, entry, offset: off, data: b64(it.data.subarray(off, off + cb)) }, from);
    }
    if (u.commit === false) return { id, begin };
    return { id, begin, commit: await call<XferCommitResult>("xfer-commit", { id, sha256: u.sha ?? hashesOf(items) }, from) };
  };
  return { base, downloads, stateDir, notifier, recv, call, upload, stop: () => { void recv.close(); rmTemp(base); } };
}

// ---- PNG üretici (geçerli, küçük; yeniden kodlama taklidi için seed ile farklı bayt) ----
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
export function png(w = 2, h = 2, seed = 0): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8 bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 3)] = 0; for (let i = 0; i < w * 3; i++) raw[y * (1 + w * 3) + 1 + i] = (seed * 31 + y * 7 + i) & 0xff; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** Geçerli imzalı ama devasa boyut beyan eden PNG (piksel sınırı testi): IHDR w*h > CLIP_MAX_PIXELS. */
export function hugePng(): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(20_000, 0); ihdr.writeUInt32BE(20_000, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(8))), chunk("IEND", Buffer.alloc(0))]);
}

// ---- kayıt tutan sahte ClipImageSink (A1'i B'den bağımsız sınamak için) ----
export class RecordingSink implements ClipImageSink {
  readonly applied: { png: Buffer; meta: { eventTs: number; rank: 0 | 1 }; from: string }[] = [];
  on = true; result: ClipImageResult = "applied";
  enabled(): boolean { return this.on; }
  async apply(p: Buffer, meta: { eventTs: number; rank: 0 | 1 }, from: string): Promise<ClipImageResult> { this.applied.push({ png: p, meta, from }); return this.result; }
}

/** clip-push dönüşü düz dize ya da {result} olabilir (plan metni {result}, harness düz dize varsayar): ikisini de kabul eder. */
export const clipResult = (r: unknown): unknown => (r && typeof r === "object" && "result" in (r as object) ? (r as { result: unknown }).result : r);

// ---- süreç içi pano çifti: iki ClipReceiver, gönderim doğrudan karşı alıcının op'una/sink'ine ----
export const text = (s: string): ClipContent => ({ kind: "text", bytes: Buffer.from(s, "utf8") });
export const image = (p: Buffer): ClipContent => ({ kind: "image", bytes: p });
export interface ClipSide {
  name: "a" | "b"; cb: FakeClipboard; recv: ClipReceiver; enabled: boolean; pushes: number; imagePushes: number;
  tick(): Promise<void>; content(): string | null;
}
export interface ClipHarness { a: ClipSide; b: ClipSide; clock: { t: number }; advance(ms?: number): number; /** açılış taban çizgisini kurar (boş panoda ilk yoklama) */ prime(): Promise<void>; stop(): Promise<void> }
/** a = işçi (rank 0), b = beyin (rank 1). `clock` elle ilerler; uyku yok. */
export function clipPair(o: { a?: ConstructorParameters<typeof FakeClipboard>[0]; b?: ConstructorParameters<typeof FakeClipboard>[0]; start?: number } = {}): ClipHarness {
  const clock = { t: o.start ?? 1_900_000_000_000 };
  const now = () => clock.t;
  const sides = {} as Record<"a" | "b", ClipSide>;
  const mk = (name: "a" | "b", opts: ConstructorParameters<typeof FakeClipboard>[0]): ClipSide => {
    const peer = name === "a" ? "b" : "a";
    const peerName = name === "a" ? "mac" : "windows"; // karşı tarafın gerçek adı (alıcı clip-push'u yalnız ctx.from === peer ise kabul eder, F-vlad-213)
    const cb = new FakeClipboard(opts);
    const s = { name, cb, enabled: true, pushes: 0, imagePushes: 0 } as ClipSide;
    const deps: ClipDeps = {
      backend: cb, now, sleep: async () => {}, isEnabled: () => s.enabled, log: () => {}, rank: name === "b" ? 1 : 0, peer: peerName, autoStart: false, settleMs: 0,
      send: {
        pushText: async (args: ClipPushArgs) => { s.pushes++; return clipResult(await sides[peer].recv.ops["clip-push"](args, { from: name === "a" ? "windows" : "mac", opId: randomUUID() })) as "applied" | "stale" | "disabled"; },
        pushImage: async (png, meta) => { s.imagePushes++; s.pushes++; return sides[peer].recv.sink.apply(png, meta, name === "a" ? "windows" : "mac"); },
      },
    };
    s.recv = createClipReceiver(deps);
    s.tick = () => s.recv.sync.tick();
    s.content = () => { const c = (cb as unknown as { content: ClipContent | null }).content; return c ? c.bytes.toString("utf8") : null; };
    return s;
  };
  sides.a = mk("a", o.a ?? {}); sides.b = mk("b", o.b ?? {});
  return {
    a: sides.a, b: sides.b, clock,
    advance(ms = 10) { clock.t += ms; return clock.t; },
    async prime() { await sides.a.tick(); await sides.b.tick(); clock.t += 10; },
    async stop() { await sides.a.recv.sync.stop().catch(() => {}); await sides.b.recv.sync.stop().catch(() => {}); },
  };
}

export const existsNoFollow = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };
export { existsSync, statSync };
