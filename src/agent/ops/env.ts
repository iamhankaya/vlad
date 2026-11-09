import type { VladConfig } from "../../kb/types.js";
import type { RemoteTransport } from "../../fleet/types.js";
import type { Journal } from "../journal.js";
import type { AgentQueue } from "../queue.js";
import type { AgentKind } from "./index.js";

/** Çalışan Agent sürecinin ortak durumu (bir süreç = bir Agent); op gövdeleri buradan okur. */
export interface AgentEnv {
  self: string;
  kind: AgentKind;
  cfg: VladConfig;
  startedAt: number;
  build: string;
  journal: Journal;
  transport: RemoteTransport;
  queue?: AgentQueue;
  /** selfUpdate başarısında yeniden başlatmayı zamanlar (start.ts kurar); yoksa yeniden başlatma yolu yoktur (ör. süreç içi testler) */
  requestRestart?: () => void;
  /** açılışta okunan dist/.build-head */
  runningBuildHead?: string;
  now(): number;
}
let current: AgentEnv | undefined;
export const setAgentEnv = (e: AgentEnv | undefined): void => { current = e; };
export function agentEnv(): AgentEnv {
  if (!current) throw new Error("agent ortamı kurulmadı");
  return current;
}
