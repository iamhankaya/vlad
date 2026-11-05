import { PROTO_VERSION } from "../../fleet/types.js";
import { agentEnv, type AgentEnv } from "./env.js";

/** Yetenekler: karşı Agent'ın aktarım/pano op'larını bilip bilmediği (sendPaths önce bunu denetler). */
export const CAPS = ["xfer", "clip"] as const;

/** worker: {machine, os, proto, build, uptimeS, caps}; beyin: {machine, proto, build, caps}. `env` enjekte edilir (aynı süreçte iki Agent: test). */
export function makePing(env: () => AgentEnv): () => Promise<unknown> {
  return async () => {
    const e = env();
    if (e.kind === "brain-agent") return { machine: e.self, proto: PROTO_VERSION, build: e.build, caps: [...CAPS] };
    return { machine: e.self, os: process.platform, proto: PROTO_VERSION, build: e.build, uptimeS: Math.floor((e.now() - e.startedAt) / 1000), caps: [...CAPS] };
  };
}
export const ping = makePing(agentEnv);
