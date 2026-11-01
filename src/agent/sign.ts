import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AgentRequest, AgentResponse } from "../machines/types.js";

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
const mac = (key: string, s: string) => createHmac("sha256", Buffer.from(key, "hex")).update(s, "utf8").digest("hex");
const same = (a: unknown, b: string) => {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const reqMsg = (r: Omit<AgentRequest, "sig">) => `VLAD1\n${r.from}\n${r.to}\n${r.opId}\n${r.ts}\n${r.op}\n${sha(canonicalJson(r.args))}`;
export const signRequest = (key: string, r: Omit<AgentRequest, "sig">): AgentRequest => ({ ...r, sig: mac(key, reqMsg(r)) });
export const verifyRequest = (key: string, r: AgentRequest): boolean => same(r.sig, mac(key, reqMsg(r)));

const resMsg = (r: Pick<AgentResponse, "opId" | "code" | "result">) => `VLAD1R\n${r.opId}\n${r.code}\n${sha(canonicalJson(r.result ?? null))}`;
export const signResponse = (key: string, r: Omit<AgentResponse, "sig">): AgentResponse => ({ ...r, sig: mac(key, resMsg(r)) });
export const verifyResponse = (key: string, r: AgentResponse): boolean => same(r.sig, mac(key, resMsg(r)));
