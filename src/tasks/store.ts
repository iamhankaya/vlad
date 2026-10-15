import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendToSection, autonomyFor, kbPaths, loadConfig, nowIso, readDoc, serializeDoc,
  setSection, validate, writeDoc,
} from "../kb/index.js";
import type { TaskData, TaskKind, TaskState } from "../kb/index.js";
import { assertTransition } from "./state.js";

export type Task = { data: TaskData; body: string; file: string };

const HEADINGS = [
  "## Tanım", "## Kabul kriterleri", "## Bağlam", "## İlerleme", "## Sorular", "## Kapanış raporu",
];

const pad2 = (n: number) => String(n).padStart(2, "0");

function dayPrefix(date: Date): string {
  return `T${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-`;
}

function taskFile(id: string): string {
  return join(kbPaths().tasks, `${id}.md`);
}

/** Next free `T<YYYYMMDD>-<NN>` for the given day. */
export function nextTaskId(tasksDir: string, date: Date): string {
  const prefix = dayPrefix(date);
  let max = 0;
  if (existsSync(tasksDir)) {
    for (const f of readdirSync(tasksDir)) {
      const m = f.startsWith(prefix) ? /^-?(\d+)\.md$/.exec(f.slice(prefix.length)) : null;
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `${prefix}${pad2(max + 1)}`;
}

function fillBody(body: string): string {
  let out = body;
  for (const h of HEADINGS) {
    if (!out.split("\n").some((l) => l.trimEnd() === h)) {
      out = `${out.replace(/\s+$/, "")}${out.trim() ? "\n\n" : ""}${h}\n`;
    }
  }
  return out.endsWith("\n") ? out : out + "\n";
}

export function createTask(
  o: { project: string; title: string; kind: TaskKind; body: string },
  now: Date = new Date(),
): Task {
  const paths = kbPaths();
  const autonomy = autonomyFor(loadConfig(), o.project);
  const body = fillBody(o.body);
  const prefix = dayPrefix(now);
  let n = Number(nextTaskId(paths.tasks, now).slice(prefix.length));
  for (;;) {
    const id = `${prefix}${pad2(n)}`;
    const ts = nowIso(now);
    const data: TaskData = {
      id, project: o.project, title: o.title, kind: o.kind, state: "queued", autonomy,
      branch: null, worktree: null, session_id: null, created: ts, updated: ts, error: null,
    };
    validate("task", data);
    const file = taskFile(id);
    try {
      writeFileSync(file, serializeDoc(data, body), { encoding: "utf8", flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        n++;
        continue;
      }
      throw e;
    }
    return { data, body, file };
  }
}

export function getTask(id: string): Task {
  const file = taskFile(id);
  if (!existsSync(file)) throw new Error(`görev bulunamadı: ${id}`);
  const { data, body } = readDoc<TaskData>(file);
  return { data, body, file };
}

export function saveTask(task: Task): void {
  task.data.updated = nowIso();
  validate("task", task.data);
  writeDoc(task.file, task.data, task.body);
}

export function listTasksWithWarnings(
  f: { state?: TaskState[]; project?: string } = {},
): { tasks: Task[]; warnings: string[] } {
  const dir = kbPaths().tasks;
  const tasks: Task[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { tasks, warnings };
  for (const name of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    const file = join(dir, name);
    try {
      const { data, body } = readDoc<TaskData>(file);
      validate("task", data);
      if (f.state && !f.state.includes(data.state)) continue;
      if (f.project && data.project !== f.project) continue;
      tasks.push({ data, body, file });
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { tasks, warnings };
}

export function listTasks(f?: { state?: TaskState[]; project?: string }): Task[] {
  return listTasksWithWarnings(f).tasks;
}

export function setState(id: string, to: TaskState, patch: Partial<TaskData> = {}): Task {
  const t = getTask(id);
  assertTransition(t.data.state, to);
  t.data = { ...t.data, ...patch, state: to };
  saveTask(t);
  return t;
}

export function logTask(id: string, msg: string): Task {
  const t = getTask(id);
  t.body = appendToSection(t.body, "## İlerleme", `- ${nowIso()} ${msg}`);
  saveTask(t);
  return t;
}

/** Validates the transition first, then writes body text and the new state in one save. */
function transitionWith(id: string, to: TaskState, edit: (body: string) => string): Task {
  const t = getTask(id);
  assertTransition(t.data.state, to);
  t.body = edit(t.body);
  t.data.state = to;
  saveTask(t);
  return t;
}

export function askTask(id: string, q: string): Task {
  return transitionWith(id, "blocked", (b) =>
    appendToSection(b, "## Sorular", `- ${nowIso()} **Soru:** ${q}`));
}

export function answerTask(id: string, a: string): Task {
  return transitionWith(id, "running", (b) =>
    appendToSection(b, "## Sorular", `- ${nowIso()} **Cevap:** ${a}`));
}

export function reportTask(id: string, md: string): Task {
  return transitionWith(id, "awaiting_approval", (b) => setSection(b, "## Kapanış raporu", md));
}

export function markStale(now: Date, hours: number): Task[] {
  const out: Task[] = [];
  for (const t of listTasks({ state: ["running"] })) {
    const updated = Date.parse(t.data.updated);
    if (Number.isNaN(updated) || updated + hours * 3600_000 >= now.getTime()) continue;
    out.push(setState(t.data.id, "stalled"));
  }
  return out;
}
