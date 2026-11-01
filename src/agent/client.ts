import { randomUUID } from "node:crypto";
import net from "node:net";
import type { VladConfig } from "../kb/types.js";
import { nowMs } from "../machines/clock.js";
import { PROTO_VERSION, RemoteError, type AgentCode, type AgentOp, type AgentRequest, type AgentResponse, type OpMeta, type RemoteTransport } from "../machines/types.js";
import { FrameDecoder, encodeFrame } from "./frame.js";
import { signRequest, verifyResponse } from "./sign.js";
import { addressOf } from "./state.js";

/** İmzasız dönebilen kodlar: sunucu kimliği doğrulamadan önce üretir. Bunlar yalnız durdurur, hiçbir şeyi silmez/onaylamaz. */
const UNSIGNED: ReadonlySet<string> = new Set(["bad_request", "auth", "too_large"]);
type WireResponse = AgentResponse & { meta?: OpMeta };

export interface ClientOpts {
  self: string;
  keys: Record<string, string>;
  /** Her çağrıda taze config (adresler sonradan değişebilir). */
  config: () => VladConfig;
  defaultTimeoutMs?: number;
}

/** RemoteTransport'un gerçek gerçeklemesi: çağrı başına yeni bağlantı, tek deneme, yeniden deneme yok. */
export class AgentClient implements RemoteTransport {
  constructor(private o: ClientOpts) {}

  async call<T = unknown>(to: string, op: AgentOp, args: unknown, c: { opId?: string; timeoutMs?: number; as?: string } = {}): Promise<{ opId: string; result: T; meta?: OpMeta }> {
    const from = c.as ?? this.o.self;
    const key = this.o.keys[from];
    if (!key) throw new RemoteError("auth", `auth: ${from} için anahtar yok (vlad.local.json)`, to);
    const addr = addressOf(this.o.config(), to, this.o.self);
    const opId = c.opId ?? randomUUID();
    const req: AgentRequest = signRequest(key, { v: PROTO_VERSION, from, to, opId, ts: nowMs(), op, args });
    const res = await this.exchange(to, addr, req, c.timeoutMs ?? this.o.defaultTimeoutMs ?? 30_000);
    if (res.opId !== opId) throw new RemoteError("auth", "auth: yanıt başka isteğe ait", to);
    if (res.sig) { if (!verifyResponse(key, res)) throw new RemoteError("auth", "auth: yanıt imzası geçersiz", to); }
    else if (res.code !== "auth" && UNSIGNED.has(res.code)) throw new RemoteError("timeout", `timeout: imzasız ${res.code} yanıtı (${res.error ?? ""}); yeniden denenir`, to); // imzasız yanıt kalıcı karar tetiklemez
    else if (res.code !== "auth") throw new RemoteError("auth", "auth: yanıt imzasız", to);
    if (res.code !== "ok") throw new RemoteError(res.code as AgentCode, res.error ?? res.code, to); // ok alanı imzalı değil; imzalı olan code'dur
    return { opId, result: res.result as T, ...(res.meta ? { meta: res.meta } : {}) };
  }

  private exchange(to: string, addr: { host: string; port: number }, req: AgentRequest, timeoutMs: number): Promise<WireResponse> {
    return new Promise((resolve, reject) => {
      const dec = new FrameDecoder();
      const sock = net.connect(addr.port, addr.host);
      let connected = false, done = false;
      const end = (e: RemoteError | null, r?: WireResponse) => {
        if (done) return;
        done = true; clearTimeout(timer); sock.destroy();
        if (e) reject(e); else resolve(r!);
      };
      const timer = setTimeout(() => end(new RemoteError("timeout", `timeout: ${to} ${timeoutMs} ms içinde yanıt vermedi`, to)), timeoutMs);
      sock.on("connect", () => { connected = true; sock.write(encodeFrame(req)); });
      sock.on("data", (d: Buffer) => {
        try { const [r] = dec.push(d); if (r) end(null, r as WireResponse); } catch (e) { end(e as RemoteError); }
      });
      // bağlanılamadı = istek hiç gitmedi; bağlandıktan sonra yanıtsız kopma = sonuç belirsiz (timeout sınıfı)
      const lost = (why: string) => end(connected
        ? new RemoteError("timeout", `timeout: ${to} yanıtsız kapandı (${why})`, to)
        : new RemoteError("unreachable", `unreachable: ${to} ${addr.host}:${addr.port} (${why})`, to));
      sock.on("error", (e) => lost((e as NodeJS.ErrnoException).code ?? e.message));
      sock.on("close", () => lost("bağlantı kapandı"));
    });
  }
}
