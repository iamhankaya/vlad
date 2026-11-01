// Kabul fazı: Agent protokolünü SÖZLEŞMEDEN (plan "Çerçeveleme ve zarf" + "Kimlik doğrulama") bağımsız konuşan ham istemci.
// İmza biçimi (B güvenlik turu sonrası; docs/machines-agent-security.md + T20261101-24 raporu, kapsam sign.ts:24,28-29):
//   istek: HMAC-SHA256(Buffer.from(key,"hex"), ["VLAD1", v, from, to, opId, ts, op, sha(canonicalJson(args))].join(LF))
//   yanıt: HMAC-SHA256(Buffer.from(key,"hex"), ["VLAD1R", v, opId, ok, code, sha(result), sha(error), sha(meta)].join(LF))  (boş alan = null)
import { createHash, createHmac, randomUUID } from "node:crypto";
import net from "node:net";

export const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hmacKey = (key: string) => Buffer.from(key, "hex");
export const signReq = (key: string, r: { v: number; from: string; to: string; opId: string; ts: number; op: string; args: unknown }) =>
  createHmac("sha256", hmacKey(key)).update(`VLAD1\n${r.v}\n${r.from}\n${r.to}\n${r.opId}\n${r.ts}\n${r.op}\n${sha(canonicalJson(r.args))}`).digest("hex");
export const signResp = (key: string, r: { v?: number; opId: string; ok?: boolean; code: string; result?: unknown; error?: unknown; meta?: unknown }) =>
  createHmac("sha256", hmacKey(key)).update(`VLAD1R\n${r.v ?? 1}\n${r.opId}\n${r.ok ?? r.code === "ok"}\n${r.code}\n${sha(canonicalJson(r.result ?? null))}\n${sha(canonicalJson(r.error ?? null))}\n${sha(canonicalJson(r.meta ?? null))}`).digest("hex");

export const frame = (json: string): Buffer => {
  const body = Buffer.from(json, "utf8");
  const h = Buffer.alloc(4);
  h.writeUInt32BE(body.length);
  return Buffer.concat([h, body]);
};

export interface RawResp { v: number; opId: string; ok: boolean; code: string; result?: any; error?: string; meta?: any; serverTs: number; build: string; sig: string }
export type RawOutcome = { kind: "response"; resp: RawResp } | { kind: "closed" } | { kind: "timeout" };

/** Ham baytları gönderir, ilk yanıt çerçevesini (varsa) okur. */
export function sendRaw(port: number, bytes: Buffer | Buffer[], o: { timeoutMs?: number; hold?: boolean } = {}): Promise<RawOutcome> {
  return new Promise((res) => {
    const c = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    let done = false;
    const fin = (r: RawOutcome) => { if (done) return; done = true; clearTimeout(t); c.destroy(); res(r); };
    const t = setTimeout(() => fin({ kind: "timeout" }), o.timeoutMs ?? 5000);
    c.on("connect", () => { for (const b of Array.isArray(bytes) ? bytes : [bytes]) c.write(b); });
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d as Buffer]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        try { fin({ kind: "response", resp: JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString("utf8")) }); } catch { fin({ kind: "closed" }); }
      }
    });
    c.on("close", () => fin({ kind: "closed" }));
    c.on("error", () => fin({ kind: "closed" }));
  });
}

export interface RawCall {
  port: number; key: string; from: string; to: string; op: string; args?: unknown;
  opId?: string; ts?: number; v?: number;
  /** imza hesaplandıktan SONRA isteği bozar (değişmiş args vb.) */
  mutate?: (req: Record<string, unknown>) => void;
  timeoutMs?: number;
}
export async function rawCall(c: RawCall): Promise<RawOutcome & { req: Record<string, unknown> }> {
  const opId = c.opId ?? randomUUID();
  const ts = c.ts ?? Date.now();
  const args = c.args ?? {};
  const v = c.v ?? 1;
  const req: Record<string, unknown> = { v, from: c.from, to: c.to, opId, ts, op: c.op, args, sig: signReq(c.key, { v, from: c.from, to: c.to, opId, ts, op: c.op, args }) };
  c.mutate?.(req);
  const out = await sendRaw(c.port, frame(JSON.stringify(req)), { timeoutMs: c.timeoutMs });
  return { ...out, req };
}
