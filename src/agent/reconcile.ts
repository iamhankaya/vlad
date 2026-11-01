import type { AgentOp } from "../machines/types.js";
import type { Journal, JournalRecord } from "./journal.js";

export type Verdict = "applied" | "not-applied" | "unknown";
/** `applied` may carry the op's result (a recovered `launch` hands it to the brain's op-status). */
export type Reconciler = (rec: JournalRecord) => Verdict | { verdict: "applied"; result: unknown };

/** Yeniden çalıştırılması zararsız işlemler: denetçisiz `started` → `aborted`. */
const IDEMPOTENT: ReadonlySet<AgentOp> = new Set<AgentOp>(["close", "cleanup", "kb-sync", "liveness", "ping", "probe-window", "op-status", "kb-head", "gate-run", "merge-preview"]);

/** Açılışta `started` kalıntılarını op'a özgü denetçiyle kapatır. */
export function reconcile(j: Journal, reconcilers: Partial<Record<AgentOp, Reconciler>>): void {
  for (const rec of j.startedList()) {
    const check = reconcilers[rec.op];
    let v: Verdict | { verdict: "applied"; result: unknown };
    if (!check) v = IDEMPOTENT.has(rec.op) ? "not-applied" : "unknown";
    else { try { v = check(rec); } catch { v = IDEMPOTENT.has(rec.op) ? "not-applied" : "unknown"; } }
    if (typeof v === "object") j.finish(rec.opId, "done", v.result, { recovered: true });
    else if (v === "applied") j.finish(rec.opId, "done", undefined, { recovered: true });
    else if (v === "not-applied") j.finish(rec.opId, "aborted");
    else j.finish(rec.opId, "done", undefined, { uncertain: true });
  }
}
