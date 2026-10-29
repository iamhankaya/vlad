import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  appendToSection, ARCHIVE, autonomyFor, CLOUD_ID_FLOOR, findMdFile, getSection, isCloudEnv, kbPaths, listMdFiles, loadConfig, nowIso, readDoc, serializeDoc,
  setSection, validate, writeDoc, writeFileAtomic,
} from "../kb/index.js";
import type { TaskData, TaskKind, TaskModel, TaskState, VladConfig } from "../kb/index.js";
import { getRole, type Role } from "../roles/store.js";
import { assertTransition } from "./state.js";

/** Advisory roles work in research tasks, executor roles in dev tasks (roles spec §4). */
const ROLE_KIND_FOR: Record<Exclude<TaskKind, "pipeline">, "advisory" | "executor"> = { research: "advisory", dev: "executor" };

/** Resolves a role and checks it fits the task kind; shared by createTask and launchTask. */
export function roleFor(slug: string, kind: TaskKind): Role {
  if (!Object.hasOwn(ROLE_KIND_FOR, kind)) throw new Error(`geçersiz görev türü: ${kind} (dev | research)`);
  const r = getRole(slug);
  if (r.kind !== ROLE_KIND_FOR[kind as keyof typeof ROLE_KIND_FOR]) {
    throw new Error(`rol ${r.slug} (${r.kind}) ${kind} görevinde kullanılamaz`);
  }
  return r;
}

export const TASK_MODELS: TaskModel[] = ["haiku", "sonnet", "opus"];

/** Model the task's worker runs on: the task's own, else its role's, else null (claude's default). */
export function effectiveModel(task: Pick<TaskData, "model">, role?: Pick<Role, "model"> | null): string | null {
  return task.model ?? role?.model ?? null;
}

/** The role's model next to the model the task really runs on; a missing/broken role file counts as no role model. */
export function modelInfo(data: TaskData): { role_model: string | null; effective_model: string | null } {
  let role: Role | null = null;
  if (data.role) {
    try { role = getRole(data.role); } catch { /* role file gone: launch reports it */ }
  }
  return { role_model: role?.model ?? null, effective_model: effectiveModel(data, role) };
}

const CLOSED: TaskState[] = ["done", "cancelled", "failed"];

/** Pipeline spec §5: a phase hangs under an open pipeline and depends only on its siblings. */
function checkLinks(o: { kind: TaskKind; role?: string | null; parent?: string | null; dependsOn?: string[] }): void {
  const deps = o.dependsOn ?? [];
  if (o.kind === "pipeline") {
    if (o.role || o.parent || deps.length) throw new Error("pipeline görevi rol/parent/bağımlılık alamaz");
    return;
  }
  if (deps.length && !o.parent) throw new Error("bağımlılık için --parent gerekli");
  if (!o.parent) return;
  assertParentOpen(o.parent, "yeni faz eklenemez");
  assertDepsInPipeline(o.parent, deps);
}

/** The pipeline task `parent` must exist, be a pipeline and not be closed. */
function assertParentOpen(parent: string, consequence: string): Task {
  const p = getTask(parent);
  if (p.data.kind !== "pipeline") throw new Error(`${parent} bir pipeline görevi değil (${p.data.kind})`);
  if (CLOSED.includes(p.data.state)) throw new Error(`çatı görev ${parent} ${p.data.state}; ${consequence}`);
  return p;
}

function assertDepsInPipeline(parent: string, deps: string[]): void {
  for (const d of deps) {
    if (getTask(d).data.parent !== parent) throw new Error(`bağımlılık ${d} aynı pipeline'da değil`);
  }
}

const TASK_ID = /^T\d{8}-\d{2,}$/;

/** Dependencies of `t` that are not done yet (a missing task counts as unmet). */
export function unmetDependencies(t: Task): string[] {
  return (t.data.depends_on ?? []).filter((d) => {
    try { return getTask(d).data.state !== "done"; } catch { return true; }
  });
}

export type DepsMode = { set?: string[]; add?: string[]; remove?: string[]; clear?: boolean };

/**
 * Changes `depends_on` of a queued pipeline phase. Everything is checked before the single write;
 * an unchanged list writes nothing. The state machine is not touched.
 */
export function setDependencies(
  id: string, mode: DepsMode,
): { task: Task; previous: string[]; changed: boolean; warnings: string[] } {
  const modes = [mode.set, mode.add, mode.remove, mode.clear ? true : undefined].filter((m) => m !== undefined);
  if (modes.length !== 1) throw new Error("tam olarak biri gerekli: --set | --add | --remove | --clear");
  if (mode.set && !mode.set.length) throw new Error("--set boş olamaz; bağımlılıkları kaldırmak için --clear kullan");
  for (const x of [id, ...(mode.set ?? []), ...(mode.add ?? []), ...(mode.remove ?? [])]) {
    if (!TASK_ID.test(x)) throw new Error(`geçersiz görev ID'si: ${x}`);
  }
  const t = getTask(id);
  if (t.data.kind === "pipeline") throw new Error(`pipeline görevinin bağımlılığı olmaz: ${id}`);
  if (!t.data.parent) throw new Error(`bağımlılık için --parent gerekli (${id} bir pipeline fazı değil)`);
  const parent = t.data.parent;
  assertParentOpen(parent, "bağımlılık değiştirilemez");
  if (t.data.state !== "queued") throw new Error(`bağımlılık yalnızca queued fazda değiştirilir (${id} ${t.data.state})`);

  const previous = t.data.depends_on ?? [];
  const warnings: string[] = [];
  let next: string[];
  if (mode.clear) next = [];
  else if (mode.set) next = mode.set;
  else if (mode.add) next = [...previous, ...mode.add];
  else {
    for (const r of mode.remove!) if (!previous.includes(r)) warnings.push(`bağımlılıkta yoktu: ${r}`);
    next = previous.filter((d) => !mode.remove!.includes(d));
  }
  next = [...new Set(next)];

  // only the dependencies that are new need checking: an old one may be done/cancelled by now
  for (const d of next.filter((x) => !previous.includes(x))) {
    if (d === id) throw new Error(`görev kendine bağlanamaz: ${id}`);
    let dep: Task;
    try { dep = getTask(d); } catch { throw new Error(`bağımlılık bulunamadı: ${d}`); }
    if (dep.data.kind === "pipeline") {
      if (d === parent) throw new Error(`bağımlılık ${d} aynı pipeline'da değil`);
      throw new Error(`bağımlılık bir pipeline görevi olamaz: ${d}`);
    }
    assertDepsInPipeline(parent, [d]);
    if (dep.data.state === "cancelled") throw new Error(`bağımlılık iptal edilmiş, asla done olmaz: ${d}`);
  }
  for (const d of next) {
    if (d !== id && getTask(d).data.state === "failed") {
      warnings.push(`bağımlılık failed: ${d}; yeniden queued/done olana kadar faz hazır olmaz`);
    }
  }
  if (next.length === previous.length && next.every((d, i) => d === previous[i])) {
    return { task: t, previous, changed: false, warnings };
  }
  if (!next.length) warnings.push(`faz bağımlılıksız kaldı: ${id}`);

  // cycle check over the whole pipeline; an unreadable task file means the graph is incomplete (fail closed)
  const { tasks, warnings: unreadable } = listTasksWithWarnings({ parent });
  if (unreadable.length) {
    throw new Error(`bağımlılık grafı eksik okundu (${unreadable[0]}); döngü denetimi yapılamaz`);
  }
  const deps = new Map(tasks.map((x) => [x.data.id, x.data.depends_on ?? []]));
  deps.set(id, next);
  const path = findPath(deps, next, id);
  if (path) throw new Error(`döngü: ${[id, ...path].join(" -> ")}`);

  // re-read just before writing: the store has no lock, so a state change in between must not be overwritten
  const fresh = getTask(id);
  if (fresh.data.state !== "queued") throw new Error(`bağımlılık yalnızca queued fazda değiştirilir (${id} ${fresh.data.state})`);
  if (JSON.stringify(fresh.data.depends_on ?? []) !== JSON.stringify(previous)) {
    throw new Error(`bağımlılık başka bir çağrıyla değişti (${id}); tekrar dene`);
  }
  fresh.data.depends_on = next;
  fresh.body = appendToSection(fresh.body, "## İlerleme", `- ${nowIso()} bağımlılık: [${previous.join(",")}] -> [${next.join(",")}]`);
  saveTask(fresh);
  return { task: fresh, previous, changed: true, warnings };
}

/** Path from one of `starts` to `target` along depends_on edges (the path ends at `target`), or null. */
function findPath(deps: Map<string, string[]>, starts: string[], target: string): string[] | null {
  const seen = new Set<string>();
  const walk = (cur: string, path: string[]): string[] | null => {
    if (cur === target) return path;
    if (seen.has(cur)) return null;
    seen.add(cur);
    for (const d of deps.get(cur) ?? []) {
      const r = walk(d, [...path, d]);
      if (r) return r;
    }
    return null;
  };
  for (const s of starts) {
    const r = walk(s, [s]);
    if (r) return r;
  }
  return null;
}

export type Task = { data: TaskData; body: string; file: string };

const HEADINGS = [
  "## Tanım", "## Kabul kriterleri", "## Bağlam", "## İlerleme", "## Sorular", "## Kapanış raporu",
];

const pad2 = (n: number) => String(n).padStart(2, "0");

function dayPrefix(date: Date): string {
  return `T${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-`;
}

/** Where the task lives: its archive file if archived, else the live path (which may not exist yet). */
function taskFile(id: string): string {
  return findMdFile(kbPaths().tasks, id) ?? join(kbPaths().tasks, `${id}.md`);
}

/** Task ids mentioned in `body` that have no task file (a typo or a made-up id; reported as a warning, not an error). */
export function unknownTaskRefs(body: string): string[] {
  const ids = new Set(body.match(/T\d{8}-\d+/g));
  return [...ids].filter((id) => !existsSync(taskFile(id)));
}

/** Next free `T<YYYYMMDD>-<NN>` for the given day. */
export function nextTaskId(tasksDir: string, date: Date): string {
  const prefix = dayPrefix(date);
  let max = isCloudEnv() ? CLOUD_ID_FLOOR : 0;
  for (const path of listMdFiles(tasksDir)) {
    const f = basename(path);
    const m = f.startsWith(prefix) ? /^-?(\d+)\.md$/.exec(f.slice(prefix.length)) : null;
    if (m) max = Math.max(max, Number(m[1]));
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
  o: {
    project: string; title: string; kind: TaskKind; body: string; role?: string | null;
    parent?: string | null; dependsOn?: string[]; phase?: string | null;
    model?: string | null; modelReason?: string | null;
  },
  now: Date = new Date(),
  /** Test seam: supplies the first candidate id (defaults to nextTaskId). */
  idSource: (tasksDir: string, date: Date) => string = nextTaskId,
): Task {
  if (o.kind !== "pipeline" && !Object.hasOwn(ROLE_KIND_FOR, o.kind)) {
    throw new Error(`geçersiz görev türü: ${o.kind} (dev | research | pipeline)`);
  }
  checkLinks(o);
  if (o.model !== undefined && o.model !== null && !TASK_MODELS.includes(o.model as TaskModel)) {
    throw new Error(`geçersiz model: ${o.model} (${TASK_MODELS.join(" | ")})`);
  }
  if (o.modelReason && !o.model) throw new Error("--model-reason yalnızca --model ile verilir");
  if (o.model === "opus" && !o.modelReason?.trim()) throw new Error("opus modeli için --model-reason (gerekçe) zorunlu");
  if (o.role) roleFor(o.role, o.kind);
  const paths = kbPaths();
  mkdirSync(paths.tasks, { recursive: true });
  const autonomy = autonomyFor(loadConfig(), o.project);
  const body = fillBody(o.body);
  const prefix = dayPrefix(now);
  let n = Number(idSource(paths.tasks, now).slice(prefix.length));
  for (;;) {
    const id = `${prefix}${pad2(n)}`;
    const ts = nowIso(now);
    const data: TaskData = {
      id, project: o.project, title: o.title, kind: o.kind, state: "queued", autonomy,
      branch: null, worktree: null, session_id: null, created: ts, updated: ts, error: null, role: o.role || null,
      parent: o.parent || null, depends_on: o.dependsOn ?? [], phase: o.phase || null,
      ...(o.model ? { model: o.model as TaskModel, ...(o.modelReason?.trim() ? { model_reason: o.modelReason.trim() } : {}) } : {}),
    };
    validate("task", data);
    if (findMdFile(paths.tasks, id)) { // taken by an archived task: the exclusive write below only sees the live dir
      n++;
      continue;
    }
    const file = taskFile(id);
    try {
      writeFileAtomic(file, serializeDoc(data, body), { exclusive: true });
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

/**
 * The task's `autonomy` froze at creation; config is the authority. Rewrites a stale frontmatter value
 * and returns the previous one (null when unchanged).
 */
export function syncAutonomy(task: Task, cfg: VladConfig): string | null {
  const current = autonomyFor(cfg, task.data.project);
  if (task.data.autonomy === current) return null;
  // re-read right before writing: a running worker may have appended a log line since `task` was read
  const fresh = getTask(task.data.id);
  const previous = fresh.data.autonomy;
  fresh.data.autonomy = task.data.autonomy = current;
  saveTask(fresh);
  return previous;
}

export function listTasksWithWarnings(
  f: { state?: TaskState[]; project?: string; parent?: string } = {},
): { tasks: Task[]; warnings: string[] } {
  const tasks: Task[] = [];
  const warnings: string[] = [];
  for (const file of listMdFiles(kbPaths().tasks)) {
    const name = basename(file);
    try {
      const { data, body } = readDoc<TaskData>(file);
      validate("task", data);
      if (f.state && !f.state.includes(data.state)) continue;
      if (f.project && data.project !== f.project) continue;
      if (f.parent && data.parent !== f.parent) continue;
      tasks.push({ data, body, file });
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { tasks, warnings };
}

export function listTasks(f?: { state?: TaskState[]; project?: string; parent?: string }): Task[] {
  return listTasksWithWarnings(f).tasks;
}

/** Queued, non-pipeline tasks whose dependencies are all done (pipeline spec §9). */
export function readyTasks(f: { parent?: string } = {}): Task[] {
  const all = listTasks();
  const state = new Map(all.map((t) => [t.data.id, t.data.state]));
  return all.filter((t) =>
    t.data.state === "queued" && t.data.kind !== "pipeline" &&
    (!f.parent || t.data.parent === f.parent) &&
    (t.data.depends_on ?? []).every((d) => state.get(d) === "done"));
}

/**
 * `readyTasks` split by the `maxParallel` limit (pipeline spec §9a): running dev tasks (all projects)
 * use up slots; the ready tasks beyond the free slots are held. No limit → everything starts.
 */
export function readyWithLimit(
  f: { parent?: string } = {}, maxParallel?: number,
): { tasks: Task[]; held_by_limit: Task[]; running: number; maxParallel: number | null } {
  const ready = readyTasks(f);
  const running = listTasks({ state: ["running"] }).filter((t) => t.data.kind === "dev").length;
  if (maxParallel === undefined) return { tasks: ready, held_by_limit: [], running, maxParallel: null };
  const free = Math.max(0, maxParallel - running);
  return { tasks: ready.slice(0, free), held_by_limit: ready.slice(free), running, maxParallel };
}

export function setState(id: string, to: TaskState, patch: Partial<TaskData> = {}): Task {
  const t = getTask(id);
  assertTransition(t.data.state, to);
  if (to === "running" && t.data.state === "queued") {
    const unmet = unmetDependencies(t);
    if (unmet.length) throw new Error(`bağımlılıklar tamamlanmadı: ${unmet.join(",")}`);
  }
  t.data = { ...t.data, ...patch, state: to };
  saveTask(t);
  // the first phase to start also starts its pipeline, whether it is a dev or a research phase
  if (to === "running" && t.data.parent) {
    const p = getTask(t.data.parent);
    if (p.data.state === "queued") setState(p.data.id, "running");
  }
  return t;
}

/** `at`: the moment the line describes (e.g. a cloud event's `created_at`); absent or unparsable → now. */
export function logTask(id: string, msg: string, at?: string): Task {
  const t = getTask(id);
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : undefined;
  t.body = appendToSection(t.body, "## İlerleme", `- ${nowIso(when)} ${msg}`);
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

/** A change-round report must be the full text; "replaces / adds to the earlier one" leaves the reader with a hole. */
const PRIOR_REF = /rapor\S*\s+(?:yerine\s+geç|(?:üst|üzer)\S*\s+ekle)|aynen\s+geçerli|#\d+\s+(?:raporu\s+)?geçerlidir/i;
export const reportReferencesPrior = (md: string): boolean => PRIOR_REF.test(md);

const PRIOR = "## Önceki raporlar";

/** The report being replaced is kept as `### Önceki rapor #n` under its own section, so dependants still get only the latest. */
export function reportTask(id: string, md: string): Task {
  return transitionWith(id, "awaiting_approval", (b) => {
    const old = getSection(b, "## Kapanış raporu");
    // the same text re-sent (CLI retry) is not a new round
    if (old && old !== md.trim()) {
      const n = (getSection(b, PRIOR)?.match(/^### Önceki rapor #\d+/gm)?.length ?? 0) + 1;
      b = appendToSection(b, PRIOR, `### Önceki rapor #${n}\n${old}`);
    }
    return setSection(b, "## Kapanış raporu", md);
  });
}

/** Done tasks whose closing report /digest has not processed yet. */
export function undigestedTasks(f: { project?: string } = {}): Task[] {
  return listTasks({ state: ["done"], project: f.project }).filter((t) => !t.data.digested);
}

/** Marks done tasks as digested; checks all of them before writing any. */
export function markDigested(ids: string[], now: Date = new Date()): Task[] {
  const tasks = ids.map(getTask);
  const bad = tasks.filter((t) => t.data.state !== "done").map((t) => `${t.data.id} (${t.data.state})`);
  if (bad.length) throw new Error(`görev done değil: ${bad.join(", ")}`);
  for (const t of tasks) {
    t.data.digested = nowIso(now);
    saveTask(t);
  }
  return tasks;
}

export function markStale(now: Date, hours: number): Task[] {
  const out: Task[] = [];
  for (const t of listTasks({ state: ["running"] })) {
    // no worker updates a pipeline; it waits on its phases and on the user's gates
    if (t.data.kind === "pipeline") continue;
    // a cloud VLAD only owns the workers it opened itself; local tasks (no cloud session_id) belong to the local VLAD
    if (isCloudEnv() && !String(t.data.session_id ?? "").startsWith("session_")) continue;
    const updated = Date.parse(t.data.updated);
    if (Number.isNaN(updated) || updated + hours * 3600_000 >= now.getTime()) continue;
    out.push(setState(t.data.id, "stalled"));
  }
  return out;
}
