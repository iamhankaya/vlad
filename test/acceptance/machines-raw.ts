// Kabul fazı: Agent protokolünü SÖZLEŞMEDEN (plan "Çerçeveleme ve zarf" + "Kimlik doğrulama") bağımsız konuşan ham istemci.
// Uygulamanın client.ts/sign.ts'ine bakılmaz; imza biçimi plan metninden: hex(HMAC-SHA256(key, "VLAD1\n"+from+"\n"+to+"\n"+opId+"\n"+ts+"\n"+op+"\n"+sha256hex(canonicalJson(args)))).
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
export const signReq = (key: string, r: { from: string; to: string; opId: string; ts: number; op: string; args: unknown }) =>
  createHmac("sha256", key).update(`VLAD1\n${r.from}\n${r.to}\n${r.opId}\n${r.ts}\n${r.op}\n${sha(canonicalJson(r.args))}`).digest("hex");
export const signResp = (key: string, r: { opId: string; code: string; result?: unknown }) =>
  createHmac("sha256", key).update(`VLAD1R\n${r.opId}\n${r.code}\n${sha(canonicalJson(r.result ?? null))}`).digest("hex");

export const frame = (json: string): Buffer => {
  const body = Buffer.from(json, "utf8");
  const h = Buffer.alloc(4);
  h.writeUInt32BE(body.length);
  return Buffer.concat([h, body]);
};

export interface RawResp { v: number; opId: string; ok: boolean; code: string; result?: any; error?: string; serverTs: number; build: string; sig: string }
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
  const req: Record<string, unknown> = { v: c.v ?? 1, from: c.from, to: c.to, opId, ts, op: c.op, args, sig: signReq(c.key, { from: c.from, to: c.to, opId, ts, op: c.op, args }) };
  c.mutate?.(req);
  const out = await sendRaw(c.port, frame(JSON.stringify(req)), { timeoutMs: c.timeoutMs });
  return { ...out, req };
}
