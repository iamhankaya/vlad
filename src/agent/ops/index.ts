import type { AgentOp } from "../../machines/types.js";

// Sözleşme (S): rol -> izinli op tablosu ve op gövdeleri. Her faz yalnız kendi op satırlarını
// `notImplemented` yerine kendi modülüne bağlar (B: ping, op-status, apply-write, exec, kb-head, forward-write, queue-*;
// C2: kb-sync, launch, resume, close, cleanup, probe-window; C3: liveness).

export type AgentKind = "worker-agent" | "brain-agent";
/** İsteği imzalayan kimliğin rolü; `self` = worker Agent'ına aynı makineden gelen yerel istemci (from==to). */
export type CallerRole = "brain" | "worker" | "console" | "self";

export interface OpContext { from: string; opId: string }
export type OpHandler = (args: unknown, ctx: OpContext) => Promise<unknown>;

export class NotImplementedOp extends Error {
  constructor(public op: AgentOp) { super(`op henüz gerçeklenmedi: ${op}`); this.name = "NotImplementedOp"; }
}
const notImplemented = (op: AgentOp): OpHandler => async () => { throw new NotImplementedOp(op); };

const ALLOWED: Record<AgentKind, Partial<Record<CallerRole, readonly AgentOp[]>>> = {
  "worker-agent": {
    brain: ["ping", "op-status", "kb-sync", "launch", "resume", "close", "cleanup", "liveness", "probe-window", "gate-run", "merge-preview", "merge"],
    self: ["forward-write", "queue-list", "queue-flush", "queue-drop"],
  },
  "brain-agent": {
    worker: ["ping", "apply-write"],
    console: ["ping", "exec", "kb-head"],
  },
};

export const allowedOps = (agent: AgentKind, caller: CallerRole): readonly AgentOp[] => ALLOWED[agent][caller] ?? [];
export const isAllowed = (agent: AgentKind, caller: CallerRole, op: AgentOp): boolean => allowedOps(agent, caller).includes(op);

const OPS: AgentOp[] = [
  "ping", "op-status", "kb-sync", "launch", "resume", "close", "cleanup", "liveness", "probe-window", "gate-run", "merge-preview", "merge",
  "apply-write", "exec", "kb-head", "forward-write", "queue-list", "queue-flush", "queue-drop",
];
export const OP_TABLE = Object.fromEntries(OPS.map((op) => [op, notImplemented(op)])) as Record<AgentOp, OpHandler>;
