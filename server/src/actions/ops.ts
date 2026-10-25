import { runVlad, runVladJson, VladError } from "../vlad/cli.ts";

/** What the executor needs from the kb, all through the `vlad` CLI (the single kb writer). Each method is safe to repeat. */
export interface VladOps {
  /** `vlad audit add`: one line per `action_id`; an existing line is success. */
  addAudit(entry: Record<string, unknown>): Promise<void>;
  setDone(taskId: string): Promise<void>;
  /** Ids of phases of `parent` that can start now (`vlad task ready --parent`; those held by `maxParallel`/quota are not returned). */
  ready(parent: string): Promise<string[]>;
  /** `vlad task launch`: mechanical start of a ready phase (no LLM turn). */
  launch(taskId: string): Promise<void>;
}

const TASK_ID = /^T[0-9]{8}-[0-9]{2,}$/;
const id = (v: string): string => {
  if (!TASK_ID.test(v)) throw new Error("geçersiz görev id");
  return v;
};

export const vladOps: VladOps = {
  async addAudit(entry) {
    try {
      await runVlad(["audit", "add", "--file", "-"], { input: JSON.stringify(entry) });
    } catch (e) {
      if (e instanceof VladError && /action_id zaten var/.test(e.message)) return;
      throw e;
    }
  },
  async setDone(taskId) {
    await runVlad(["task", "set", id(taskId), "done"]);
  },
  async ready(parent) {
    const r = await runVladJson<{ tasks: { id: string }[] }>(["task", "ready", "--parent", id(parent)]);
    return r.tasks.map((t) => t.id);
  },
  async launch(taskId) {
    await runVlad(["task", "launch", id(taskId)], { timeoutMs: 60_000 });
  },
};
