import { renderNotification } from "./request.js";
import type { ChannelConfig, PendingRecord, ResultRecord } from "./types.js";

/**
 * SÖZLEŞME iskeleti (gövde U3'te). Giden bağlantı yalnız (Node `fetch`); gelen port yok (statik arch testi gelen bağlantı kodunu yasaklar).
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

const MAX_LINE = 16 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const realSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((res) => {
  if (signal.aborted) return res();
  const t = setTimeout(done, ms);
  function done(): void { clearTimeout(t); signal.removeEventListener("abort", done); res(); }
  signal.addEventListener("abort", done);
});

export class NtfyChannel implements ApproverChannel {
  private readonly base: string;
  /** `cfg.server`: https zorunlu; yalnız loopback host için http (test). `sleep` yeniden bağlanma gecikmesi için enjekte edilebilir. */
  constructor(private readonly cfg: ChannelConfig, private readonly fetchFn: typeof fetch = fetch, private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = realSleep) {
    let u: URL;
    try { u = new URL(cfg.server); } catch { throw new Error("ntfy: gecersiz sunucu adresi"); }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new Error("ntfy: sunucu adresi https olmali");
    this.base = u.origin;
  }

  private async post(payload: unknown): Promise<void> {
    const res = await this.fetchFn(`${this.base}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`ntfy: yayin basarisiz (HTTP ${res.status})`);
  }

  async publishRequest(p: PendingRecord, tags: { approve: string; deny: string }): Promise<void> {
    const { title, message } = renderNotification(p);
    const url = `${this.base}/${p.respTopic}`;
    const act = (label: string, body: string) => ({ action: "http", label, url, method: "POST", body, clear: true });
    await this.post({
      topic: this.cfg.requestTopic, title, message, priority: 4, tags: ["warning"],
      actions: [act("Reddet", `d1.${p.id}.${tags.deny}`), act("Onayla", `a1.${p.id}.${tags.approve}`)],
    });
  }

  async watchResponse(topic: string, sinceUnix: number, h: WatchHandlers, signal: AbortSignal): Promise<void> {
    let since = String(sinceUnix);
    let failures = 0;
    const state = (s: "connecting" | "ready" | "retry" | "closed") => h.onState?.(s);
    while (!signal.aborted) {
      state("connecting");
      let delay: number | undefined;
      try {
        const res = await this.fetchFn(`${this.base}/${topic}/json?since=${encodeURIComponent(since)}`, { method: "GET", signal });
        if (res.status === 429) {
          const ra = Number(res.headers.get("retry-after"));
          if (Number.isFinite(ra) && ra > 0) delay = Math.min(ra, 3600);
        } else if (!res.ok || !res.body) {
          // yeniden dene
        } else {
          let ready = false;
          const markReady = () => { if (!ready) { ready = true; failures = 0; state("ready"); h.onReady?.(); } };
          markReady();
          const dec = new TextDecoder();
          const reader = res.body.getReader();
          let buf = "";
          let skipping = false;
          const line = (l: string) => {
            if (!l.trim() || l.length > MAX_LINE) return;
            let o: unknown;
            try { o = JSON.parse(l); } catch { return; }
            if (!o || typeof o !== "object") return;
            const e = o as { id?: unknown; event?: unknown; topic?: unknown; message?: unknown };
            if (e.event === "open") return markReady();
            if (e.event !== "message" || e.topic !== topic || typeof e.message !== "string") return;
            if (typeof e.id === "string" && e.id) since = e.id;
            h.onBody(e.message);
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const l = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (skipping) skipping = false; else line(l);
            }
            if (buf.length > MAX_LINE) { buf = ""; skipping = true; }
          }
          buf += dec.decode();
          if (!skipping) line(buf);
        }
      } catch {
        if (signal.aborted) break;
      }
      if (signal.aborted) break;
      failures++;
      state("retry");
      await this.sleep((delay ?? Math.min(60, 2 ** (failures - 1))) * 1000, signal);
    }
    state("closed");
  }

  async publishResult(r: ResultRecord): Promise<void> {
    const code = r.exitCode === null ? "-" : String(r.exitCode);
    await this.post({ topic: this.cfg.requestTopic, title: `VLAD sonuc: ${r.status}`, message: `Durum: ${r.status}, cikis kodu: ${code}`, tags: ["information_source"] });
  }
}
