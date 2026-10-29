import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { kbPaths } from "./home.js";
import { decisionFileFor, decisionTitle } from "./journal.js";
import { nowIso } from "./time.js";

export const DECISION_STATUSES = ["geçerli", "geçersiz", "yerine-geçti"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DECISION_HEADING = /^### (\d{4}-\d{2}-\d{2}) — (.+?) — (.*)$/;
const ID = /^D-([a-z0-9][a-z0-9-]*)-(\d{3,})$/;
const META = /^- \*\*(ID|Durum|Geçersiz kılan|Geçersiz kıldığı):\*\* (.+?)\s*$/;
const KEYS = { id: "ID", status: "Durum", superseded_by: "Geçersiz kılan", supersedes: "Geçersiz kıldığı" } as const;
type MetaKey = keyof typeof KEYS;

export interface DecisionRecord {
  id: string;
  /** `decisions/<file>.md` without extension (`_genel` for general decisions) */
  file: string;
  date: string;
  title: string;
  status: DecisionStatus;
  superseded_by?: string;
  supersedes?: string;
  source?: string;
  /** first line of the `**Karar:**` bullet, at most 200 chars */
  summary: string;
  /** absolute path of the decision file */
  path: string;
}

interface Block { start: number; end: number; date: string; title: string; meta: Partial<Record<MetaKey, string>> }

/** Blocks of a decision file as line ranges; the file's own lines stay the only copy, so edits cannot lose text. */
function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  lines.forEach((l, i) => {
    const m = DECISION_HEADING.exec(l);
    if (m) out.push({ start: i, end: lines.length, date: m[1], title: m[3], meta: {} });
  });
  out.forEach((b, i) => {
    if (i + 1 < out.length) b.end = out[i + 1].start;
    for (let j = b.start + 1; j < b.end; j++) {
      const m = META.exec(lines[j]);
      const key = m && (Object.keys(KEYS) as MetaKey[]).find((k) => KEYS[k] === m[1]);
      if (key && m) b.meta[key] = m[2];
    }
  });
  return out;
}

const slugOfFile = (file: string) => (file === "_genel" ? "genel" : file);
const fileOfSlug = (slug: string) => (slug === "genel" ? "_genel" : slug);
const decisionPath = (file: string) => join(kbPaths().decisions, `${file}.md`);
const readLines = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n");
const maxNumber = (bs: Block[]) => bs.reduce((n, b) => Math.max(n, Number(ID.exec(b.meta.id ?? "")?.[2] ?? 0)), 0);
const newId = (file: string, n: number) => `D-${slugOfFile(file)}-${String(n).padStart(3, "0")}`;

function decisionFiles(project?: string): string[] {
  const dir = kbPaths().decisions;
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).sort();
  return project ? files.filter((f) => f === fileOfSlug(project)) : files;
}

/** Locates a decision by id; the id's project part names its file. */
function locate(id: string): { path: string; lines: string[]; block: Block } {
  const m = ID.exec(id);
  if (!m) throw new Error(`geçersiz karar ID'si: ${id} (D-<proje>-<NNN>)`);
  const path = decisionPath(fileOfSlug(m[1]));
  if (existsSync(path)) {
    const lines = readLines(path);
    const block = blocks(lines).find((b) => b.meta.id === id);
    if (block) return { path, lines, block };
  }
  throw new Error(`karar bulunamadı: ${id}`);
}

/** Replaces a metadata bullet of a block, or inserts it after the block's existing ones; undefined removes it. */
function setMeta(lines: string[], block: Block, key: MetaKey, value: string | undefined): void {
  const label = KEYS[key];
  const at = lines.findIndex((l, i) => i > block.start && i < block.end && META.exec(l)?.[1] === label);
  const line = value === undefined ? null : `- **${label}:** ${value}`;
  if (at >= 0) {
    if (line === null) lines.splice(at, 1); else lines[at] = line;
  } else if (line !== null) {
    let ins = block.start + 1;
    while (ins < block.end && META.test(lines[ins])) ins++;
    lines.splice(ins, 0, line);
  }
}

/** Spec 5.4: appends a `### <date> — <project> — <title>` block with ID and status to kb/decisions/<project>.md; returns the new `D-<proje>-NNN`. */
export function addDecision(
  o: { project: string; title: string; body: string; source?: string; supersedes?: string },
  now: Date = new Date(),
): string {
  const file = decisionFileFor(o.project);
  const path = decisionPath(file);
  if (o.supersedes) locate(o.supersedes); // fail before writing anything
  const cur = existsSync(path) ? readLines(path) : [];
  const id = newId(file, maxNumber(blocks(cur)) + 1);
  const head = `### ${nowIso(now).slice(0, 10)} — ${o.project} — ${o.title}`;
  const meta = [`- **ID:** ${id}`, `- **Durum:** geçerli`, ...(o.supersedes ? [`- **Geçersiz kıldığı:** ${o.supersedes}`] : [])];
  const source = o.source ? [`- **Kaynak:** ${o.source}`] : [];
  const block = [head, ...meta, ...o.body.replace(/\r\n/g, "\n").trim().split("\n"), ...source].join("\n");
  const base = (cur.length ? cur.join("\n") : decisionTitle(file)).replace(/\s+$/, "");
  mkdirSync(kbPaths().decisions, { recursive: true });
  writeFileAtomic(path, `${base}\n\n${block}\n`);
  if (o.supersedes) setDecisionStatus(o.supersedes, "yerine-geçti", id);
  return id;
}

/** Every decision block (also unmigrated ones, `id` empty) with its verbatim text; the one scan behind `listDecisions` and `kb search`. */
export function scanDecisions(project?: string): { rec: DecisionRecord; text: string }[] {
  const out: { rec: DecisionRecord; text: string }[] = [];
  for (const file of decisionFiles(project)) {
    const path = decisionPath(file);
    const lines = readLines(path);
    for (const b of blocks(lines)) {
      const status = (DECISION_STATUSES as readonly string[]).includes(b.meta.status ?? "") ? (b.meta.status as DecisionStatus) : "geçerli";
      const body = lines.slice(b.start + 1, b.end);
      const pick = (label: string) => body.map((l) => new RegExp(String.raw`^- \*\*${label}:\*\* (.*)$`).exec(l)?.[1]).find((v) => v !== undefined);
      const source = pick("Kaynak")?.trim();
      out.push({
        rec: {
          id: b.meta.id ?? "", file, date: b.date, title: b.title, status,
          ...(b.meta.superseded_by ? { superseded_by: b.meta.superseded_by } : {}),
          ...(b.meta.supersedes ? { supersedes: b.meta.supersedes } : {}),
          ...(source ? { source } : {}),
          summary: (pick("Karar") ?? "").slice(0, 200), path,
        },
        text: lines.slice(b.start, b.end).join("\n").trim(),
      });
    }
  }
  return out;
}

/** Decisions of one project (or all), only geçerli ones unless `all`. Blocks without an ID are skipped: `vlad decision migrate` numbers them. */
export function listDecisions(o: { project?: string; all?: boolean } = {}): DecisionRecord[] {
  return scanDecisions(o.project).map((d) => d.rec).filter((r) => r.id && (o.all || r.status === "geçerli"));
}

/** Changes a decision's status; `yerine-geçti` needs the replacing decision (and links it back). */
export function setDecisionStatus(id: string, status: string, supersededBy?: string): void {
  if (!(DECISION_STATUSES as readonly string[]).includes(status)) throw new Error(`geçersiz durum: ${status} (${DECISION_STATUSES.join(" | ")})`);
  if (status === "yerine-geçti" && !supersededBy) throw new Error("yerine-geçti için --superseded-by <karar-id> gerekli");
  if (status !== "yerine-geçti" && supersededBy) throw new Error("--superseded-by yalnız yerine-geçti ile kullanılır");
  if (supersededBy === id) throw new Error("karar kendisinin yerine geçemez");
  const target = locate(id);
  const by = supersededBy ? locate(supersededBy) : null;
  setMeta(target.lines, target.block, "status", status);
  setMeta(target.lines, target.block, "superseded_by", supersededBy);
  writeFileAtomic(target.path, target.lines.join("\n"));
  if (by && !by.block.meta.supersedes) {
    const fresh = locate(supersededBy!); // re-read: it may be the file just written
    setMeta(fresh.lines, fresh.block, "supersedes", id);
    writeFileAtomic(fresh.path, fresh.lines.join("\n"));
  }
}

/** Gives every decision block without an ID the next `D-<proje>-NNN` and status geçerli; nothing else changes. Idempotent. */
export function migrateDecisions(o: { dryRun?: boolean } = {}): { file: string; assigned: number }[] {
  const report: { file: string; assigned: number }[] = [];
  for (const file of decisionFiles()) {
    const path = decisionPath(file);
    const lines = readLines(path);
    const bs = blocks(lines);
    let n = maxNumber(bs);
    const todo = bs.filter((b) => !b.meta.id);
    if (!todo.length) continue;
    for (const b of todo) b.meta.id = newId(file, ++n); // document order for numbering
    for (const b of [...todo].reverse()) { // insert from the bottom so earlier line ranges stay valid
      lines.splice(b.start + 1, 0, `- **ID:** ${b.meta.id}`, ...(b.meta.status ? [] : ["- **Durum:** geçerli"]));
    }
    if (!o.dryRun) writeFileAtomic(path, lines.join("\n"));
    report.push({ file, assigned: todo.length });
  }
  return report;
}
