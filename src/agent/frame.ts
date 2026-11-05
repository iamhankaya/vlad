import { MAX_FRAME_BYTES, RemoteError } from "../fleet/types.js";

/** 4 bayt big-endian uzunluk + UTF-8 JSON. */
export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new RemoteError("too_large", "çerçeve 8 MiB'ı aşıyor");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Artımlı çözücü: parçalar gelir, tamamlanan çerçeveler döner. Uzunluk başlığı sınırı aşarsa gövde beklenmeden reddedilir. */
export class FrameDecoder {
  private buf = Buffer.alloc(0);
  get pending(): boolean { return this.buf.length > 0; }
  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (n > MAX_FRAME_BYTES) throw new RemoteError("too_large", "çerçeve 8 MiB'ı aşıyor");
      if (this.buf.length < 4 + n) break;
      const body = this.buf.subarray(4, 4 + n).toString("utf8");
      this.buf = this.buf.subarray(4 + n);
      try { out.push(JSON.parse(body)); } catch { throw new RemoteError("bad_request", "çerçeve geçerli JSON değil"); }
    }
    return out;
  }
}
