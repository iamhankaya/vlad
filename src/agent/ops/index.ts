import type { AgentOp } from "../../fleet/types.js";
import { applyWrite } from "./apply-write.js";
import { exec } from "./exec.js";
import { forwardWrite } from "./forward-write.js";
import { kbHead } from "./kb-head.js";
import { opStatus } from "./op-status.js";
import { makePing, ping } from "./ping.js";
import { kbSync } from "./kb-sync.js";
import { cleanupOp, closeOp, launchOp, resumeOp } from "./launch.js";
import { probeWindow } from "./probe-window.js";
import { gateRun, mergeOp, mergePreview } from "./gate.js";
import { parseBranchPushArgs } from "./branch-push.js";
import { liveness } from "./liveness.js";
import { scriptList, scriptRun } from "./script.js";
import { queueDrop, queueFlush, queueList } from "./queue.js";
import { createClipReceiver } from "../../clip/receive.js";
import { createXferReceiver } from "../../transfer/receive.js";
import type { AktarimDeps } from "../../transfer/types.js";

// Sözleşme (S): rol -> izinli op tablosu ve op gövdeleri. Her faz yalnız kendi op satırlarını
// `notImplemented` yerine kendi modülüne bağlar (B: ping, op-status, apply-write, exec, kb-head, forward-write, queue-*;
// C2: kb-sync, launch, resume, close, cleanup, probe-window; C3: liveness; C4: gate-run, merge-preview, merge).

export type AgentKind = "worker-agent" | "brain-agent";
/** İsteği imzalayan kimliğin rolü; `self` = worker Agent'ına aynı makineden gelen yerel istemci (from==to). */
export type CallerRole = "brain" | "worker" | "console" | "self";

export interface OpContext { from: string; opId: string }
export type OpHandler = (args: unknown, ctx: OpContext) => Promise<unknown>;

export class NotImplementedOp extends Error {
  constructor(public op: AgentOp) { super(`op henüz gerçeklenmedi: ${op}`); this.name = "NotImplementedOp"; }
}
const notImplemented = (op: AgentOp): OpHandler => async () => { throw new NotImplementedOp(op); };

/** Aktarım/pano op'ları: yalnız beyin↔işçi (iki yönlü itme); `console` ve `self` rollerine verilmez. */
export const TRANSFER_OPS: readonly AgentOp[] = ["xfer-begin", "xfer-chunk", "xfer-commit", "xfer-abort", "clip-push"];

const ALLOWED: Record<AgentKind, Partial<Record<CallerRole, readonly AgentOp[]>>> = {
  "worker-agent": {
    brain: ["ping", "op-status", "kb-sync", "launch", "resume", "close", "cleanup", "liveness", "probe-window", "gate-run", "merge-preview", "merge", "branch-push", "script-list", "script-run", ...TRANSFER_OPS],
    self: ["forward-write", "queue-list", "queue-flush", "queue-drop"],
  },
  "brain-agent": {
    worker: ["ping", "apply-write", ...TRANSFER_OPS],
    console: ["ping", "exec", "kb-head"],
  },
};

export const allowedOps = (agent: AgentKind, caller: CallerRole): readonly AgentOp[] => ALLOWED[agent][caller] ?? [];
export const isAllowed = (agent: AgentKind, caller: CallerRole, op: AgentOp): boolean => allowedOps(agent, caller).includes(op);

const OPS: AgentOp[] = [
  "ping", "op-status", "kb-sync", "launch", "resume", "close", "cleanup", "liveness", "probe-window", "gate-run", "merge-preview", "merge", "branch-push", "script-list", "script-run",
  "apply-write", "exec", "kb-head", "forward-write", "queue-list", "queue-flush", "queue-drop",
  ...TRANSFER_OPS,
];
export const OP_TABLE = Object.fromEntries(OPS.map((op) => [op, notImplemented(op)])) as Record<AgentOp, OpHandler>;
// --- machines:B --- B'nin op satırları
OP_TABLE.ping = () => ping();
OP_TABLE["op-status"] = (a, c) => opStatus(a, c);
OP_TABLE["apply-write"] = (a, c) => applyWrite(a, c);
OP_TABLE.exec = (a, c) => exec(a, c);
OP_TABLE["kb-head"] = () => kbHead();
OP_TABLE["forward-write"] = (a) => forwardWrite(a);
OP_TABLE["queue-list"] = () => queueList();
OP_TABLE["queue-flush"] = () => queueFlush();
OP_TABLE["queue-drop"] = (a) => queueDrop(a);
// --- /machines:B ---
// --- machines:C2 --- C2'nin op satırları
OP_TABLE["probe-window"] = () => probeWindow();
OP_TABLE["kb-sync"] = (a) => kbSync(a);
OP_TABLE.launch = (a, c) => launchOp(a, c);
OP_TABLE.resume = (a) => resumeOp(a);
OP_TABLE.close = (a) => closeOp(a);
OP_TABLE.cleanup = (a) => cleanupOp(a);
// --- /machines:C2 ---
// --- machines:C3 ---
OP_TABLE.liveness = (a) => liveness(a);
// --- /machines:C3 ---
// --- machines:C4 ---
OP_TABLE["gate-run"] = (a) => gateRun(a);
OP_TABLE["merge-preview"] = (a) => mergePreview(a);
OP_TABLE.merge = (a) => mergeOp(a);
// --- /machines:C4 ---
// --- machines:branch-push (F-vlad-314) ---
// sözleşme: yalnız şema doğrulanır; gövde (git push) uygulama fazında
OP_TABLE["branch-push"] = async (a) => { parseBranchPushArgs(a); throw new NotImplementedOp("branch-push"); };
// --- /machines:branch-push ---
// --- scripts: kayıtlı bakım betikleri (T20261109-03) ---
OP_TABLE["script-list"] = (a) => scriptList(a);
OP_TABLE["script-run"] = (a, c) => scriptRun(a, undefined, c);
// --- /scripts ---

/**
 * Aktarım S: op tablosunu `d`'ye bağlar. Süreç geneli durum yok: her çağrı ayrı alıcılar kurar (aynı süreçte iki Agent: test).
 * `sweep`/`close` yaşam döngüsü start.ts içindir. OP_TABLE dışa aktarımı mevcut testler için kalır.
 */
export function buildAktarim(d: AktarimDeps): { ops: Record<AgentOp, OpHandler>; sweep(): Promise<number>; close(): Promise<void> } {
  const clip = createClipReceiver(d.clip);
  // Resim panosu: clip-image commit'i clip alıcısının sink'ine gider (F-vlad-230); testte açıkça verilen sink ezilmez.
  const xfer = createXferReceiver({ ...d.xfer, clipImage: d.xfer.clipImage ?? clip.sink });
  const ops = { ...OP_TABLE, ping: makePing(d.env), ...xfer.ops, ...clip.ops } as Record<AgentOp, OpHandler>;
  return { ops, sweep: () => xfer.sweep(), close: () => xfer.close() };
}
export const buildOps = (d: AktarimDeps): Record<AgentOp, OpHandler> => buildAktarim(d).ops;
