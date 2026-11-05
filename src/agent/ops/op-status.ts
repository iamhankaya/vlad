import { RemoteError } from "../../machines/types.js";
import { agentEnv } from "./env.js";
import { resolveUncertainLaunch } from "./launch.js";

/** {target: opId, cancel?}: durumu döner; hiç görülmemiş ve cancel:true ise iptal işareti (tombstone) yazar. */
export async function opStatus(args: unknown, ctx: { from: string }): Promise<{ state: "started" | "done" | "aborted" | "unknown" | "cancelled"; result?: unknown; truncated?: true }> {
  const a = args as { target?: unknown; cancel?: unknown } | null;
  if (!a || typeof a.target !== "string" || !a.target) throw new RemoteError("bad_request", "bad_request: target gerekli");
  const j = agentEnv().journal;
  const rec = j.get(a.target);
  if (!rec) {
    if (a.cancel === true) { j.tombstone(a.target, ctx.from); return { state: "cancelled" }; }
    return { state: "unknown" };
  }
  if (rec.state === "aborted-cancelled") return { state: "cancelled" };
  // sonuç günlükte kırpıldıysa "done" tek başına sahte tam başarı olurdu: açıkça işaretlenir, işaret nesnesi sonuç diye verilmez (F-vlad-152)
  if (rec.state === "done" && (rec.result as { __journalTruncated?: boolean } | undefined)?.__journalTruncated) return { state: "done", truncated: true };
  if (rec.state === "done" && rec.op === "launch" && rec.result === undefined) return resolveUncertainLaunch(a.target);
  return { state: rec.state, ...(rec.state === "done" && rec.result !== undefined ? { result: rec.result } : {}) };
}
