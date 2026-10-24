import { nowIso } from "../kb/index.js";
import type { TaskPr } from "../kb/index.js";
import { getTask, saveTask } from "./store.js";
import type { Task } from "./store.js";

/** Latest progress of a running task; `pct` null = indeterminate. Replaces the previous value. */
export function setProgress(id: string, pct: number | null, label: string): Task {
  if (pct !== null && (!Number.isInteger(pct) || pct < 0 || pct > 100)) throw new Error(`pct 0-100 arası tam sayı olmalı: ${pct}`);
  if (!label.trim()) throw new Error("label boş olamaz");
  const t = getTask(id);
  t.data.progress = { pct, label: label.trim(), at: nowIso() };
  saveTask(t);
  return t;
}

/** Pull request the task's branch is under; replaces the previous one. */
export function setPr(id: string, pr: TaskPr): Task {
  const t = getTask(id);
  t.data.pr = pr.url ? { number: pr.number, repo: pr.repo, base: pr.base, url: pr.url } : { number: pr.number, repo: pr.repo, base: pr.base };
  saveTask(t);
  return t;
}
