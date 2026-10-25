import type { CardData, GateInfo, Progress, PullRequestRef, TaskData, TaskState } from "./types.ts";

const pick = <T extends object>(o: T, keys: (keyof T)[]): Partial<T> =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as Partial<T>;

/** A stored card as the API shows it: only schema fields, so nothing extra in a kb file reaches the phone. */
export function toCard(c: CardData): Record<string, unknown> {
  return {
    ...pick(c, ["id", "kind", "project", "task", "state", "title"]),
    options: c.options.map((o) => ({ id: o.id, label: o.label })),
    answer: c.answer,
    ...(c.action ? { action: pick(c.action, ["kind", "repo", "pr", "base", "ref", "sha"]) } : {}),
    created: c.created,
    updated: c.updated,
  };
}

const progressOf = (p: Progress | null | undefined): Progress | null => (p ? { pct: p.pct, label: p.label, at: p.at } : null);
const prOf = (p: PullRequestRef | null | undefined): PullRequestRef | null =>
  p ? { number: p.number, repo: p.repo, base: p.base, ...(p.url ? { url: p.url } : {}) } : null;

/** branch/worktree/session_id (server paths and ids) stay out of the API. */
export function toTask(t: TaskData, report: string | null): Record<string, unknown> {
  return {
    id: t.id, project: t.project, title: t.title, kind: t.kind, state: t.state, autonomy: t.autonomy,
    role: t.role ?? null, parent: t.parent ?? null, depends_on: t.depends_on ?? [], phase: t.phase ?? null,
    host: t.host ?? null, progress: progressOf(t.progress), pr: prOf(t.pr), error: t.error ?? null, report_md: report,
    created: t.created, updated: t.updated,
  };
}

/** Task states that count as "a worker" on the Today screen. */
const WORKER_STATES: TaskState[] = ["running", "blocked", "stalled", "awaiting_approval"];

export function toWorker(t: TaskData): Record<string, unknown> {
  return {
    task_id: t.id, project: t.project, title: t.title, phase: t.phase ?? null, state: t.state,
    host: t.host ?? null, progress: progressOf(t.progress), updated: t.updated,
  };
}
export const isWorker = (t: TaskData) => t.kind !== "pipeline" && WORKER_STATES.includes(t.state);

export const GATE_OPTIONS = [{ id: "merge", label: "Merge et" }, { id: "changes", label: "Değişiklik iste" }];

/** The derived (never stored) card of a task waiting for approval. */
export function gateCard(t: TaskData, info: Omit<GateInfo, "task_id" | "phase" | "report_md">, reportMd: string): Record<string, unknown> {
  return {
    id: `gate-${t.id}`, kind: "gate", project: t.project, task: t.id, state: "open",
    title: `${t.title} onay bekliyor`.slice(0, 200),
    options: GATE_OPTIONS.map((o) => ({ ...o })), answer: null,
    gate: {
      task_id: t.id, phase: t.phase ?? null, pr: prOf(info.pr), head_sha: info.head_sha, ci: info.ci, mergeable: info.mergeable,
      report_md: reportMd, ...(info.merge_kind ? { merge_kind: info.merge_kind } : {}), reviews: info.reviews,
    },
    created: t.created, updated: t.updated,
  };
}

export function toPipelines(tasks: TaskData[]): Record<string, unknown>[] {
  return tasks.filter((t) => t.kind === "pipeline").map((root) => ({
    task_id: root.id, project: root.project, title: root.title, state: root.state,
    phases: tasks.filter((t) => t.parent === root.id).map((t) => ({
      task_id: t.id, title: t.title, state: t.state, phase: t.phase ?? null, role: t.role ?? null,
      depends_on: t.depends_on ?? [], progress: progressOf(t.progress),
    })),
  }));
}
