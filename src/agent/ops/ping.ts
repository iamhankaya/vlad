import { PROTO_VERSION } from "../../machines/types.js";
import { agentEnv } from "./env.js";

/** worker: {machine, os, proto, build, uptimeS}; beyin: {machine, proto, build}. */
export async function ping(): Promise<unknown> {
  const e = agentEnv();
  if (e.kind === "brain-agent") return { machine: e.self, proto: PROTO_VERSION, build: e.build };
  return { machine: e.self, os: process.platform, proto: PROTO_VERSION, build: e.build, uptimeS: Math.floor((e.now() - e.startedAt) / 1000) };
}
