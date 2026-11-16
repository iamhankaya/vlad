import type { ChannelConfig, PendingRecord, ResultRecord } from "./types.js";

/**
 * SÖZLEŞME iskeleti (gövde U3'te). Giden bağlantı yalnız (Node `fetch`); gelen port yok (statik arch testi: `node:net`/`node:http(s)`/`createServer`/`.listen(` yasak).
 * Telegram vb. sonradan aynı `ApproverChannel` arayüzüyle. ntfy yayın biçimi ve akış varsayımları: test/fixtures/ntfy/README.md (belge türevli; gerçek yakalama doğrulama fazında).
 */
export interface WatchHandlers { onBody(body: string): void; onReady?(): void; onState?(s: "connecting" | "ready" | "retry" | "closed"): void }

export interface ApproverChannel {
  /** Gizli istek konusuna (`vlad-q-…`) bildirim; eylem düğmeleri yanıt konusuna `d1.<id>.<tag>` / `a1.<id>.<tag>` POST eder. */
  publishRequest(p: PendingRecord, tags: { approve: string; deny: string }): Promise<void>;
  /** NDJSON akışı; yeniden bağlanma içeride (1→60 sn), since=<son id>; satır ≤ 16 KB, bozuk satır atlanır, parçalı UTF-8 işlenir; 429 Retry-After uyulur; topic/event alanları doğrulanır. `ready` olmadan bildirim yayınlanmaz. */
  watchResponse(topic: string, sinceUnix: number, h: WatchHandlers, signal: AbortSignal): Promise<void>;
  /** Sonuç bildirimi: yalnız kullanıcı bilgisidir, güvenlik kanıtı sayılmaz; ham stdout taşımaz. */
  publishResult(r: ResultRecord): Promise<void>;
}

export class NtfyChannel implements ApproverChannel {
  /** `serverUrl`: https zorunlu; yalnız loopback host için http (test). */
  constructor(private readonly cfg: ChannelConfig, private readonly fetchFn: typeof fetch = fetch) { void this.cfg; void this.fetchFn; }
  publishRequest(p: PendingRecord, tags: { approve: string; deny: string }): Promise<void> { void p; void tags; throw new Error("not implemented"); }
  watchResponse(topic: string, sinceUnix: number, h: WatchHandlers, signal: AbortSignal): Promise<void> { void topic; void sinceUnix; void h; void signal; throw new Error("not implemented"); }
  publishResult(r: ResultRecord): Promise<void> { void r; throw new Error("not implemented"); }
}
