import { PROTO_VERSION } from "../../fleet/types.js";
import { maint } from "../maintenance.js";
import { agentEnv, type AgentEnv } from "./env.js";

/** Yetenekler: karşı Agent'ın aktarım/pano op'larını bilip bilmediği (sendPaths önce bunu denetler). */
export const CAPS = ["xfer", "clip"] as const;

/** worker: {machine, os, proto, build, uptimeS, caps}; beyin: {machine, proto, build, caps}. `env` enjekte edilir (aynı süreçte iki Agent: test). */
export function makePing(env: () => AgentEnv): () => Promise<unknown> {
  return async () => {
    const e = env();
    // bakım + uçuştaki op'lar (F-vlad-274/278): selfUpdate neden `busy` döndüğü ve kurtarmanın takılıp takılmadığı ping'ten okunur; ping kendi opId'sini saymaz (muaf)
    const m = maint.snapshot(), inflight = maint.list();
    const vis = { ...(m.on ? { maintenance: { on: true, reason: m.reason, sinceMs: m.sinceMs, attempts: m.attempts, stuck: m.stuck } } : {}), inflight };
    if (e.kind === "brain-agent") return { machine: e.self, proto: PROTO_VERSION, build: e.build, caps: [...CAPS], ...vis };
    return { machine: e.self, os: process.platform, proto: PROTO_VERSION, build: e.build, uptimeS: Math.floor((e.now() - e.startedAt) / 1000), caps: [...CAPS], ...vis };
  };
}
export const ping = makePing(agentEnv);
