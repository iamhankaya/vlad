import type { RemoteTransport } from "../fleet/types.js";
import { uploadBuffer } from "../transfer/send.js";
import type { ClipSenders } from "./types.js";

type Upload = typeof uploadBuffer;

/**
 * Gerçek ClipSenders: metin `clip-push` op'uyla, resim `clip-image` amaçlı yükleme (xfer-*) ile karşıya gider.
 * `transport` ve `peer` her çağrıda okunur (Agent ortamı ve config sonradan kurulur/değişir). Hata fırlatır: ClipSync yeniden dener.
 */
export function createClipSenders(transport: () => RemoteTransport, peer: () => string | null, upload: Upload = uploadBuffer): ClipSenders {
  const to = (): string => { const p = peer(); if (!p) throw new Error("karşı makine yok (pano eşitleme yalnız iki makinede çalışır)"); return p; };
  return {
    async pushText(a) {
      const r = await transport().call<"applied" | "stale" | "disabled">(to(), "clip-push", a, { timeoutMs: 15_000 });
      return r.result;
    },
    async pushImage(png, meta) {
      const r = await upload(transport(), to(), png, { purpose: "clip-image", name: "clip.png", meta });
      return r.clip ?? "invalid";
    },
  };
}
