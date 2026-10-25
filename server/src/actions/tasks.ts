import { runVladJson, VladError } from "../vlad/cli.ts";
import type { TaskSource } from "./service.ts";

/** Task facts from `vlad task show`. A task that does not exist is `null`; every other CLI failure propagates. */
export const vladTaskSource: TaskSource = async (id) => {
  try {
    const { task } = await runVladJson<{ task: { id: string; state: string; parent?: string | null; pr?: { number: number; repo: string; base: string } | null } }>(["task", "show", id]);
    return { id: task.id, state: task.state, parent: task.parent ?? null, pr: task.pr ? { number: task.pr.number, repo: task.pr.repo, base: task.pr.base } : null };
  } catch (e) {
    if (e instanceof VladError && e.kind === "not_found") return null;
    throw e;
  }
};
