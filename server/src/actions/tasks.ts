import { runVladJson, VladError } from "../vlad/cli.ts";
import type { ProjectSource, TaskSource } from "./service.ts";

/** Task facts from `vlad task show`. A task that does not exist is `null`; every other CLI failure propagates. */
export const vladTaskSource: TaskSource = async (id) => {
  try {
    const { task } = await runVladJson<{ task: { id: string; project: string; state: string; parent?: string | null; pr?: { number: number; repo: string; base: string } | null } }>(["task", "show", id]);
    return { id: task.id, project: task.project, state: task.state, parent: task.parent ?? null, pr: task.pr ? { number: task.pr.number, repo: task.pr.repo, base: task.pr.base } : null };
  } catch (e) {
    if (e instanceof VladError && e.kind === "not_found") return null;
    throw e;
  }
};

/** The project card's `repo` and `default_branch` (`vlad project list`); an unknown slug is `null`. */
export const vladProjectSource: ProjectSource = async (slug) => {
  const { projects } = await runVladJson<{ projects: { slug: string; repo?: string; default_branch?: string }[] }>(["project", "list"]);
  const p = projects.find((x) => x.slug === slug);
  return p ? { ...(p.repo ? { repo: p.repo } : {}), ...(p.default_branch ? { default_branch: p.default_branch } : {}) } : null;
};
