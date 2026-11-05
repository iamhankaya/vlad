import { createHash } from "node:crypto";
import { RemoteError } from "../machines/types.js";
import { CLIP_MAX_IMAGE_BYTES, CLIP_MAX_PIXELS, CLIP_MAX_TEXT_BYTES, CLIP_POLL_MS } from "./types.js";
import type { ApplyResult, ClipContent, ClipDeps, ClipKind, ClipSyncLike, OrderKey } from "./types.js";

// Ortak pano eşitleyici (plan T20261105-04 karar 5). Tasarım:
// - Yankı: uzak yazmadan sonra `lastSeq = seqAfter` (yazma ve yoklama tek kilit altında), böylece (fromSeq, toSeq] aralığındaki
//   değişiklikler bizim yazımızdır ve gönderilmez; içeriğe bakılmaz (CRLF dönüşümü, PNG yeniden kodlama, bumpPerWrite:2 bozmaz).
//   `seqAfter`'dan sonraki artış gerçek yerel olaydır (aynı içerik olsa da gönderilir).
// - Son yazan: tek toplam sıra `OrderKey = [eventTs, rank, counter]`; gelen anahtar `lastWinner`'dan büyük değilse "stale".
// - Ağ gönderimi kilidin DIŞINDA yapılır: iki Agent aynı anda birbirine gönderirken karşılıklı kilit beklemesi (deadlock) olmasın.
// shortcut: Windows'ta yazma sonrası gecikmeli changeCount artışı ayar süresini (settleMs) aşarsa sahte yerel olay görülebilir; piksel/metin özeti sonraki iş.

const RETRY_MAX_AGE_MS = 10 * 60_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const SETTLE_TRIES = 3;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Anlamsal özet: metin CRLF/CR→LF normalize + UTF-8 → sha256("text:"+bytes); resim sha256("image:"+bytes). Yalnız günlük/ek koruma. */
export function semanticHash(c: ClipContent): string {
  const h = createHash("sha256");
  if (c.kind === "text") { h.update("text:"); h.update(c.bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8"); } else { h.update("image:"); h.update(c.bytes); }
  return h.digest("hex");
}

/** PNG imzası + IHDR boyutu (0 < w*h ≤ CLIP_MAX_PIXELS). Piksel çözülmez. */
export function validPng(b: Buffer): boolean {
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIG) || b.readUInt32BE(8) !== 13 || b.toString("ascii", 12, 16) !== "IHDR") return false;
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  return w > 0 && h > 0 && w * h <= CLIP_MAX_PIXELS;
}
export function validUtf8(b: Buffer): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
}
export function compareKeys(a: OrderKey, b: OrderKey): number {
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}
/** Sınır ve geçerlilik: null = gönderilebilir, aksi neden. */
function rejectReason(c: ClipContent): string | null {
  if (c.kind === "text") return c.bytes.length > CLIP_MAX_TEXT_BYTES ? "metin 1 MiB'ı aşıyor" : !validUtf8(c.bytes) ? "metin geçerli UTF-8 değil" : null;
  return c.bytes.length > CLIP_MAX_IMAGE_BYTES ? "resim 20 MiB'ı aşıyor" : !validPng(c.bytes) ? "resim geçerli PNG değil" : null;
}

interface Pending { content: ClipContent; key: OrderKey; fails: number; nextAt: number }

export class ClipSync implements ClipSyncLike {
  private lastSeq: number | null = null;
  private readonly t0: number;
  private lastWinner: OrderKey;
  private counter: number;
  private pending: Pending | null = null;
  private sending = false;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private lastErr = "";
  private readonly ready: Promise<void>;

  constructor(private d: ClipDeps) {
    this.t0 = d.now();
    this.counter = this.t0;
    this.lastWinner = [this.t0, d.rank, this.counter];
    // Taban çizgisi kuruluş anında alınır (sonradan gelen değişiklik olaydır). Karşı makine yoksa yardımcıyı boşuna başlatma.
    let p: Promise<number>;
    try { p = d.peer === null ? Promise.reject(new Error("peer yok")) : d.backend.changeCount(); } catch (e) { p = Promise.reject(e); }
    this.ready = p.then((n) => { if (this.lastSeq === null) this.lastSeq = n; }, () => {});
  }

  tick(): Promise<void> {
    return this.exclusive(() => this.detect()).then(() => this.flush());
  }

  async applyRemote(m: { kind: ClipKind; bytes: Buffer; key: OrderKey; from: string }): Promise<ApplyResult> {
    return this.exclusive(async () => {
      const d = this.d;
      await this.ready;
      if (!d.isEnabled()) return "disabled";
      if (m.kind === "text") {
        if (m.bytes.length > CLIP_MAX_TEXT_BYTES) return "too_large";
        if (!validUtf8(m.bytes)) throw new RemoteError("bad_request", "bad_request: metin geçerli UTF-8 değil");
      } else {
        if (m.bytes.length > CLIP_MAX_IMAGE_BYTES) return "too_large";
        if (!validPng(m.bytes)) return "bad_image";
      }
      if (compareKeys(m.key, this.lastWinner) <= 0) return "stale";
      const seq = await d.backend.changeCount();
      if (this.lastSeq === null) this.lastSeq = seq;
      if (seq !== this.lastSeq) return "local_changed"; // henüz görülmemiş yerel kopya: onu ezme (sonraki yoklama gönderir)
      const w = await d.backend.write({ kind: m.kind, bytes: m.bytes }, seq);
      if (!w.written) return "local_changed";
      let after = w.seqAfter;
      if ((d.settleMs ?? 0) > 0) {
        for (let i = 0; i < SETTLE_TRIES; i++) {
          await (d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(d.settleMs!);
          const now = await d.backend.changeCount();
          if (now === after) break;
          after = now;
        }
      }
      this.lastSeq = after;
      this.lastWinner = m.key;
      if (this.pending && compareKeys(this.pending.key, m.key) < 0) this.pending = null;
      d.log(`uzak ${m.kind} uygulandı (${m.from}, ${m.bytes.length} bayt)`);
      return "applied";
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inflight) return;
      this.inflight = this.tick().then(() => { this.lastErr = ""; }, (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== this.lastErr) this.d.log(`yoklama hatası: ${msg}`);
        this.lastErr = msg;
      }).finally(() => { this.inflight = null; });
    }, CLIP_POLL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inflight;
    await this.chain.catch(() => {});
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Yerel değişikliği saptar ve bekleyen değeri kurar (kilit altında; ağ yok). */
  private async detect(): Promise<void> {
    const d = this.d;
    await this.ready;
    const seq = await d.backend.changeCount();
    if (this.lastSeq === null) { this.lastSeq = seq; return; }
    if (!d.isEnabled() || d.peer === null) { this.lastSeq = seq; this.pending = null; return; } // kapalıyken yalnız sayaç ilerler: içerik okunmaz
    if (seq === this.lastSeq) return;
    const eventTs = d.now();
    if (eventTs <= this.t0) { this.lastSeq = seq; return; } // kuruluş anıyla aynı anda olan içerik taban çizgisidir
    const r = await d.backend.read();
    this.lastSeq = r.seq;
    const key = this.nextKey(eventTs);
    this.lastWinner = key; // içerik gönderilemese de (CF_HDROP, sınır) daha eski uzak değerlerin üstüne yazılmasını engeller
    this.pending = null;
    const c = r.content;
    if (!c) return;
    const why = rejectReason(c);
    if (why) { d.log(`yerel pano gönderilmedi: ${why}`); return; }
    this.pending = { content: c, key, fails: 0, nextAt: 0 };
  }

  /** Lamport düzeltmesi: yerel olay, bildiğimiz son anahtardan her zaman sonradır (saat sapması/geri gitme yerel kopyayı ezdirmez). */
  private nextKey(eventTs: number): OrderKey {
    this.counter = Math.max(this.counter + 1, eventTs);
    const key: OrderKey = [eventTs, this.d.rank, this.counter];
    return compareKeys(key, this.lastWinner) > 0 ? key : [this.lastWinner[0] + 1, this.d.rank, this.counter];
  }

  /** Bekleyen değeri karşıya iter (kilit dışında). Hata: üstel geri çekilmeyle yeniden dene, 10 dk sonra at. */
  private async flush(): Promise<void> {
    const p = this.pending, d = this.d;
    if (!p || this.sending || d.now() < p.nextAt) return;
    if (d.now() - p.key[0] > (d.retryMaxAgeMs ?? RETRY_MAX_AGE_MS)) { this.pending = null; d.log("bekleyen pano değeri çok eski, atıldı"); return; }
    this.sending = true;
    try {
      const [eventTs, rank, counter] = p.key;
      const res = p.content.kind === "text"
        ? await d.send.pushText({ kind: "text", data: p.content.bytes.toString("base64"), eventTs, rank, counter })
        : await d.send.pushImage(p.content.bytes, { eventTs, rank });
      d.log(`${p.content.kind} gönderildi (${semanticHash(p.content).slice(0, 8)}): ${res}`);
      if (this.pending === p) this.pending = null;
    } catch (e) {
      p.fails++;
      p.nextAt = d.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** p.fails);
      d.log(`gönderim başarısız: ${e instanceof Error ? e.message : String(e)}`);
    } finally { this.sending = false; }
  }
}
