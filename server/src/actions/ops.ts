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
    await runVlad(["task", "set", taskId, "done"]);
  },
  async ready(parent) {
    const r = await runVladJson<{ tasks: { id: string }[] }>(["task", "ready", "--parent", parent]);
    return r.tasks.map((t) => t.id);
  },
  async launch(taskId) {
    await runVlad(["task", "launch", taskId], { timeoutMs: 60_000 });
  },
};
