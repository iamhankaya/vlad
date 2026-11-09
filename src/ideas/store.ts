import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { findMdFile, kbPaths, listMdFiles, nowIso, readDoc, serializeDoc, validate, writeDoc, writeFileAtomic } from "../kb/index.js";
import type { IdeaData, IdeaState } from "../kb/index.js";
import { getFinding, setFindingStates, UNRESOLVED } from "../findings/store.js";
import { getKbRecord } from "../kb/get.js";

export type Idea = { data: IdeaData; body: string; file: string };

export const IDEA_STATES: readonly IdeaState[] = ["open", "promoted", "dropped"];

const DETAIL = "## Ayrıntı";
const CLOSING = "## Kapanış";
const ID_RE = /^I-[a-z0-9-]+-\d+$/;

function ideaFile(id: string): string {
  return findMdFile(kbPaths().ideas, id) ?? join(kbPaths().ideas, `${id}.md`);
}

/** Next free `I-<project>-NNN` (numbering is per project; archived ideas keep their numbers). */
export function nextIdeaId(dir: string, project: string): string {
  const prefix = `I-${project}-`;
  let max = 0;
  for (const path of listMdFiles(dir)) {
    const f = basename(path);
    const m = f.startsWith(prefix) ? /^(\d+)\.md$/.exec(f.slice(prefix.length)) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

function checkProject(project: string): void {
  if (!/^[a-z0-9-]+$/.test(project)) throw new Error(`geçersiz proje slug'ı: "${project}" (yalnızca a-z, 0-9 ve '-')`);
  if (!existsSync(join(kbPaths().projects, `${project}.md`))) throw new Error(`proje kartı bulunamadı: ${project}`);
}

export function addIdea(o: { project: string; title: string; detail?: string; source?: string }, now: Date = new Date()): Idea {
  checkProject(o.project);
  const title = o.title.trim();
  if (!title) throw new Error("başlık boş olamaz");
  const dir = kbPaths().ideas;
  mkdirSync(dir, { recursive: true });
  const detail = (o.detail ?? "").trim();
  const body = `${DETAIL}\n${detail ? detail + "\n" : ""}`;
  const prefix = `I-${o.project}-`;
  let n = Number(nextIdeaId(dir, o.project).slice(prefix.length));
  for (;;) {
    const id = `${prefix}${String(n).padStart(3, "0")}`;
    const ts = nowIso(now);
    const data: IdeaData = { id, project: o.project, title, state: "open", ...(o.source ? { source: o.source } : {}), created: ts, updated: ts };
    validate("idea", data);
    if (findMdFile(dir, id)) { n++; continue; } // taken by an archived idea: the exclusive write below only sees the live dir
    const file = ideaFile(id);
    try {
      writeFileAtomic(file, serializeDoc(data, body), { exclusive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") { n++; continue; }
      throw e;
    }
    return { data, body, file };
  }
}

export function getIdea(id: string): Idea {
  const file = ID_RE.test(id) ? ideaFile(id) : "";
  if (!file || !existsSync(file)) throw new Error(`fikir bulunamadı: ${id}`);
  const { data, body } = readDoc<IdeaData>(file);
  return { data, body, file };
}

/** Valid ideas in id order; unreadable or invalid files are skipped and reported as warnings. */
export function listIdeas(f: { project?: string; state?: IdeaState[] } = {}): { ideas: Idea[]; warnings: string[] } {
  const ideas: Idea[] = [];
  const warnings: string[] = [];
  for (const file of listMdFiles(kbPaths().ideas)) {
    const name = basename(file);
    if (f.project && !(name.startsWith(`I-${f.project}-`) && /^\d+\.md$/.test(name.slice(f.project.length + 3)))) continue;
    try {
      const { data, body } = readDoc<IdeaData>(file);
      validate("idea", data);
      if (f.state && !f.state.includes(data.state)) continue;
      ideas.push({ data, body, file });
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { ideas, warnings };
}

/** Number of open ideas of a project (kept apart from the findings counts). */
export function countOpenIdeas(project: string): number {
  return listIdeas({ project, state: ["open"] }).ideas.length;
}

/** Closing transition of an open idea; the note is appended to `## Kapanış` (history is kept). */
function closeIdea(i: Idea, state: "promoted" | "dropped", note: string, extra: Partial<IdeaData>, now: Date): { data: IdeaData; body: string } {
  if (i.data.state !== "open") throw new Error(`${i.data.id} yalnız open fikir kapatılabilir (şu an: ${i.data.state})`);
  const ts = nowIso(now);
  const data = { ...i.data, ...extra, state, updated: ts } as IdeaData;
  validate("idea", data);
  const line = `- ${ts} ${state} — ${note.replace(/\s*\n\s*/g, " ")}\n`;
  const body = /^## Kapanış\s*$/m.test(i.body) ? i.body.replace(/\n*$/, "\n") + line : `${i.body.replace(/\n*$/, "")}\n\n${CLOSING}\n${line}`;
  return { data, body };
}

/** Drops ideas, all-or-nothing: every id and the reason are validated before the first write. Only `dropped` is a `set` target (`promoted` goes through `promoteIdea`). */
export function setIdeaStates(ids: string[], state: string, o: { reason?: string } = {}, now: Date = new Date()): Idea[] {
  if (state !== "dropped") throw new Error(`geçersiz durum: "${state}" (set yalnız dropped; promoted için idea promote)`);
  const uniq = [...new Set(ids)];
  if (!uniq.length) throw new Error("en az bir fikir ID'si gerekli");
  const reason = o.reason?.trim();
  if (!reason) throw new Error("dropped için --reason zorunlu");
  const planned = uniq.map((id) => {
    const i = getIdea(id);
    return { i, n: closeIdea(i, "dropped", reason, {}, now) };
  });
  return planned.map(({ i, n }) => { writeDoc(i.file, n.data, n.body); return { ...n, file: i.file }; });
}

/** Marks an open idea as taken on by a task. */
export function promoteIdea(id: string, task: string, now: Date = new Date()): Idea {
  if (!/^T\d{8}-\d{2,}$/.test(task)) throw new Error(`geçersiz görev ID: ${task} (T<YYYYMMDD>-<NN>)`);
  const i = getIdea(id);
  if (i.data.state !== "open") throw new Error(`${id} yalnız open fikir kapatılabilir (şu an: ${i.data.state})`);
  let t;
  try { t = getKbRecord(task); } catch { throw new Error(`görev bulunamadı: ${task}`); }
  if (t.data.project !== i.data.project) throw new Error(`${task} başka projenin görevi (${String(t.data.project)}); fikir: ${i.data.project}`);
  const n = closeIdea(i, "promoted", task, { promoted_task: task }, now);
  writeDoc(i.file, n.data, n.body);
  return { ...n, file: i.file };
}

/** Moves open/deferred findings into the idea store: one idea per finding (source = finding id, detail kept), the finding becomes `wontfix`. All-or-nothing on the checks. */
export function fromFindings(ids: string[], now: Date = new Date()): { finding: string; idea: Idea }[] {
  const uniq = [...new Set(ids)];
  if (!uniq.length) throw new Error("en az bir bulgu ID'si gerekli");
  const fs = uniq.map((id) => getFinding(id));
  for (const f of fs) {
    if (!(UNRESOLVED as readonly string[]).includes(f.data.state)) throw new Error(`${f.data.id} açık değil (${f.data.state}): fikre taşınamaz`);
    checkProject(f.data.project);
  }
  // ideas first (rolled back if one fails), then close the findings; a re-run reuses the open idea of the same source instead of opening a twin
  const created: Idea[] = [];
  const moved: { finding: string; idea: Idea }[] = [];
  try {
    for (const f of fs) {
      const reuse = listIdeas({ project: f.data.project, state: ["open"] }).ideas.find((i) => i.data.source === f.data.id);
      const detail = f.body.replace(/^## Ayrıntı\n?/, "").trim();
      const idea = reuse ?? addIdea({ project: f.data.project, title: f.data.title, detail, source: f.data.id }, now);
      if (!reuse) created.push(idea);
      moved.push({ finding: f.data.id, idea });
    }
  } catch (e) {
    for (const i of created) unlinkSync(i.file);
    throw e;
  }
  // each finding names its own idea; all checks ran above, a failed write restores the finding files and drops the ideas this run opened
  const before = fs.map((f) => ({ file: f.file, text: readFileSync(f.file, "utf8") }));
  try {
    for (const m of moved) setFindingStates([m.finding], "wontfix", { reason: `fikir deposuna taşındı: ${m.idea.data.id}` }, now);
  } catch (e) {
    for (const b of before) if (readFileSync(b.file, "utf8") !== b.text) writeFileAtomic(b.file, b.text);
    for (const i of created) unlinkSync(i.file);
    throw e;
  }
  return moved;
}
