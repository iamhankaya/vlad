import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AgentRequest, AgentResponse } from "../fleet/types.js";

export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const mac = (key: string, s: string) => {
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("anahtar biçimi geçersiz (64 hex bekleniyor)");
  return createHmac("sha256", Buffer.from(key, "hex")).update(s, "utf8").digest("hex");
};
const same = (a: unknown, b: string) => {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const reqMsg = (r: Omit<AgentRequest, "sig">) => `VLAD1\n${r.v}\n${r.from}\n${r.to}\n${r.opId}\n${r.ts}\n${r.op}\n${sha(canonicalJson(r.args))}`;
export const signRequest = (key: string, r: Omit<AgentRequest, "sig">): AgentRequest => ({ ...r, sig: mac(key, reqMsg(r)) });
export const verifyRequest = (key: string, r: AgentRequest): boolean => { try { return same(r.sig, mac(key, reqMsg(r))); } catch { return false; } };

type Signable = Pick<AgentResponse, "v" | "opId" | "ok" | "code" | "result" | "error"> & { meta?: unknown };
const resMsg = (r: Signable) => `VLAD1R\n${r.v}\n${r.opId}\n${r.ok}\n${r.code}\n${sha(canonicalJson(r.result ?? null))}\n${sha(canonicalJson(r.error ?? null))}\n${sha(canonicalJson(r.meta ?? null))}`;
export const signResponse = <T extends Omit<AgentResponse, "sig"> & { meta?: unknown }>(key: string, r: T): T & { sig: string } => ({ ...r, sig: mac(key, resMsg(r)) });
export const verifyResponse = (key: string, r: AgentResponse & { meta?: unknown }): boolean => { try { return same(r.sig, mac(key, resMsg(r))); } catch { return false; } };
