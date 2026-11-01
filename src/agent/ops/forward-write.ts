import { randomUUID } from "node:crypto";
import { RemoteError, type ExecResult, type WriteArgs } from "../../machines/types.js";
import { agentEnv } from "./env.js";
import { parseWriteArgs } from "./apply-write.js";

export type ForwardResult = ExecResult | { queued: true; seq: number; opId: string; reason?: string };
/** Doğrudan gönderimde bu kodlar kuyruğa alınmaz: hata CLI'a aynen döner (kalıcı hata). */
const PERMANENT = new Set(["forbidden", "failed", "bad_request", "not_found", "conflict", "too_large"]);

const brainOf = () => agentEnv().cfg.brain!;
const wire = (w: WriteArgs): WriteArgs => ({ cmd: w.cmd, id: w.id, ...(w.text !== undefined ? { text: w.text } : {}), ...(w.sessionId !== undefined ? { sessionId: w.sessionId } : {}), ...(w.json ? { json: true } : {}) });

/**
 * CLI → yerel Agent: yazma isteğini beyne iletir. Kuyruk boş ve beyin ulaşılabilirse doğrudan `apply-write`
 * (opId önce diske `inflight` yazılır); kuyruk doluysa sıra bozulmasın diye kuyruğa eklenir.
 */
export async function forwardWrite(args: unknown): Promise<ForwardResult> {
  const e = agentEnv();
  const q = e.queue!;
  const w = parseWriteArgs(args);
  const opId = randomUUID();
  if (!q.isEmpty()) {
    const it = q.enqueue({ ...w, opId });
    void flushQueue();
    return { queued: true, seq: it.seq, opId };
  }
  const it = q.enqueue({ ...w, opId }, "inflight");
  try {
    const r = await e.transport.call<ExecResult>(brainOf(), "apply-write", wire(w), { opId });
    q.remove(it.seq);
    return r.result;
  } catch (err) {
    if (err instanceof RemoteError && PERMANENT.has(err.code)) { q.remove(it.seq); throw err; }
    const reason = (err as Error).message;
    q.setState(it.seq, "pending", reason); // geçici / auth / proto_mismatch / belirsiz: girdi kalır, sonra yeniden denenir
    return { queued: true, seq: it.seq, opId, reason };
  }
}

/** Kuyruğu sırayla beyne boşaltır (aynı opId → beyin günlüğü tekrarı çiftlemez). */
export function flushQueue(): Promise<{ sent: number; failed: number; remaining: number }> {
  const e = agentEnv();
  return e.queue!.flush(async (it) => {
    const r = await e.transport.call<ExecResult>(brainOf(), "apply-write", wire(it), { opId: it.opId });
    if (r.result && r.result.exit !== 0) throw new RemoteError("failed", `failed: komut çıkış ${r.result.exit}: ${(r.result.stderr ?? "").trim()}`); // sessiz kayıp yok: failed/'a gider
  });
}
