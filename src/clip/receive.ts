import type { OpHandler } from "../agent/ops/index.js";
import { CLOCK_SKEW_MS, RemoteError } from "../machines/types.js";
import type { ClipImageResult, ClipImageSink } from "../transfer/types.js";
import { ClipSync } from "./sync.js";
import { CLIP_MAX_TEXT_BYTES } from "./types.js";
import type { ClipDeps, ClipPushArgs, ClipReceiver } from "./types.js";

// ClipReceiver: `clip-push` op'u (metin) ve ClipImageSink (resim; A1'in clip-image commit'i çağırır). Panoya yalnız içerik yazılır:
// komut satırına/kabuğa hiçbir şey gömülmez, içerik yorumlanmaz ya da dosyaya yazılmaz (kabul edilen risk: pano enjeksiyonu, docs/aktarim-pano.md).
const MAX_B64 = Math.ceil(CLIP_MAX_TEXT_BYTES / 3) * 4 + 4;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const bad = (m: string) => new RemoteError("bad_request", `bad_request: ${m}`);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// Aynı ClipDeps için tek alıcı: op, sink ve yoklama (startClipSync) aynı ClipSync durumunu (lastWinner, lastSeq) paylaşır.
const cache = new WeakMap<ClipDeps, ClipReceiver>();

export function createClipReceiver(d: ClipDeps): ClipReceiver {
  const hit = cache.get(d);
  if (hit) return hit;
  const sync = new ClipSync(d);
  const future = (eventTs: number) => eventTs > d.now() + CLOCK_SKEW_MS; // geçmişte alt sınır yok: sıralama anahtarı korur

  const push: OpHandler = async (args) => {
    const a = args as Partial<ClipPushArgs> | null;
    if (!a || typeof a !== "object" || a.kind !== "text" || typeof a.data !== "string") throw bad("clip-push biçimi geçersiz");
    if (!isInt(a.eventTs) || !isInt(a.counter) || (a.rank !== 0 && a.rank !== 1)) throw bad("clip-push anahtarı geçersiz");
    if (a.data.length > MAX_B64) throw new RemoteError("too_large", "too_large: metin 1 MiB'ı aşıyor");
    if (!B64.test(a.data)) throw bad("data geçerli base64 değil");
    if (future(a.eventTs)) throw bad("olay zamanı gelecekte");
    if (!d.isEnabled()) return "disabled";
    const r = await sync.applyRemote({ kind: "text", bytes: Buffer.from(a.data, "base64"), key: [a.eventTs, a.rank, a.counter], from: "uzak" });
    if (r === "too_large") throw new RemoteError("too_large", "too_large: metin 1 MiB'ı aşıyor");
    return r === "applied" || r === "disabled" ? r : "stale"; // stale, local_changed (ve beklenmeyen) → gönderen yeniden denemesin
  };

  const sink: ClipImageSink = {
    enabled: () => d.isEnabled(),
    async apply(png, meta, from): Promise<ClipImageResult> {
      if (!d.isEnabled()) return "disabled";
      if (!isInt(meta?.eventTs) || (meta.rank !== 0 && meta.rank !== 1) || future(meta.eventTs)) return "invalid";
      const r = await sync.applyRemote({ kind: "image", bytes: png, key: [meta.eventTs, meta.rank, 0], from });
      return r === "applied" || r === "disabled" ? r : r === "too_large" || r === "bad_image" ? "invalid" : "stale";
    },
  };

  const rec: ClipReceiver = { ops: { "clip-push": push }, sink, sync };
  cache.set(d, rec);
  if (d.autoStart) sync.start();
  return rec;
}
