import { RemoteError, type QueueEntry } from "../../machines/types.js";
import { agentEnv } from "./env.js";
import { flushQueue } from "./forward-write.js";

export async function queueList(): Promise<{ entries: QueueEntry[] }> {
  return { entries: agentEnv().queue!.list() };
}
export const queueFlush = (): ReturnType<typeof flushQueue> => flushQueue();
export async function queueDrop(args: unknown): Promise<{ dropped: true }> {
  const seq = (args as { seq?: unknown } | null)?.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq)) throw new RemoteError("bad_request", "bad_request: seq tamsayı olmalı");
  if (!agentEnv().queue!.remove(seq)) throw new RemoteError("not_found", `not_found: kuyrukta yok: ${seq}`);
  return { dropped: true };
}
