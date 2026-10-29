import { existsSync } from "node:fs";
import { join } from "node:path";
import { listFindingsWithWarnings, SEVERITIES, UNRESOLVED } from "../findings/store.js";
import { getSection, kbPaths, listDecisions, nowIso, readDoc, setSection, validate, writeDoc } from "../kb/index.js";
import type { DecisionRecord, ProjectCard } from "../kb/index.js";
import { listTasksWithWarnings } from "../tasks/store.js";

const SUMMARY = "## Durum özeti";
const AS_OF = /^_Güncel: (.+)_$/;
/** ~1000 tokens of Turkish prose; longer summaries defeat the purpose of a short status. */
const MAX_SUMMARY_CHARS = 6000;
const CLOSED = ["done", "cancelled"];
/** Keeps the status near the ~1000 token target on projects with hundreds of records. */
const LIST_MAX = 15;
const LISTED_SEVERITIES = ["kritik", "yüksek", "orta"];

export interface ProjectStatus {
  slug: string;
  status: string;
  last_activity: string | null;
  gate: string | null;
  summary: {
    /** yok: no section; güncel: no record newer than `as_of`; bayat: records newer than `as_of` exist (listed in `newer`) */
    state: "yok" | "güncel" | "bayat";
    as_of: string | null;
    newer: string[];
    text: string | null;
    chars: number;
  };
  tasks: {
    counts: Record<string, number>;
    active: { id: string; state: string; kind: string; phase: string | null; title: string; updated: string }[];
    last_done: { id: string; title: string; updated: string } | null;
  };
  findings: {
    /** open + deferred, per severity */
    counts: Record<string, number>;
    /** kritik/yüksek/orta only, at most LIST_MAX (the full list: `vlad finding list`) */
    open: { id: string; severity: string; state: string; title: string }[];
  };
  decisions: {
    total: number;
    /** newest LIST_MAX valid decisions (the full list: `vlad decision list --project`) */
    recent: Pick<DecisionRecord, "id" | "date" | "title">[];
  };
}

function cardOf(slug: string): { file: string; data: ProjectCard; body: string } {
  const file = join(kbPaths().projects, `${slug}.md`);
  if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(file)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  return { file, ...readDoc<ProjectCard>(file) };
}

/** Writes the card's `## Durum özeti` section (replacing it); the first line records how far the summary is current. */
export function setProjectSummary(slug: string, text: string, asOf: Date = new Date()): string {
  const { file, data, body } = cardOf(slug);
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) throw new Error("özet boş olamaz");
  if (clean.split("\n").some((l) => /^## /.test(l))) throw new Error("özette `## ` başlık satırı olamaz (kartın bölümünü böler)");
  if (clean.length > MAX_SUMMARY_CHARS) throw new Error(`özet çok uzun: ${clean.length} > ${MAX_SUMMARY_CHARS} karakter (~1000 token)`);
  validate("project", data);
  const stamp = nowIso(asOf);
  writeDoc(file, data, setSection(body, SUMMARY, `_Güncel: ${stamp}_\n\n${clean}`));
  return stamp;
}

/** Counts, open records and valid decisions come from the records; only the narrative comes from the card. */
export function projectStatus(slug: string): ProjectStatus {
  const { data, body } = cardOf(slug);
  const { tasks } = listTasksWithWarnings({ project: slug });
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.data.state] = (counts[t.data.state] ?? 0) + 1;
  const { findings } = listFindingsWithWarnings({ project: slug, state: [...UNRESOLVED] });
  const decisions = listDecisions({ project: slug });

  const raw = getSection(body, SUMMARY);
  const asOf = raw ? AS_OF.exec(raw.split("\n")[0])?.[1] ?? null : null;
  const text = raw ? (asOf ? raw.split("\n").slice(1).join("\n").trim() : raw) : null;
  const cutoff = asOf ? Date.parse(asOf) : NaN;
  const newer: string[] = [];
  if (Number.isFinite(cutoff)) {
    // `task digested` re-stamps `updated` with the same instant as `digested`: that is /digest finishing, not new work
    for (const t of tasks) if (Date.parse(t.data.updated) > cutoff && t.data.digested !== t.data.updated) newer.push(t.data.id);
    for (const f of listFindingsWithWarnings({ project: slug }).findings) if (Date.parse(f.data.updated) > cutoff) newer.push(f.data.id);
    // shortcut: decisions carry a date only, so one added later the same day as the summary is not seen; /digest writes the summary after the decisions
    for (const d of listDecisions({ project: slug, all: true })) if (d.date > asOf!.slice(0, 10)) newer.push(d.id);
  }
  const state = !raw ? "yok" : Number.isFinite(cutoff) && !newer.length ? "güncel" : "bayat"; // no timestamp: cannot vouch for it

  const done = tasks.filter((t) => t.data.state === "done").sort((a, b) => b.data.updated.localeCompare(a.data.updated))[0];
  return {
    slug, status: data.status, last_activity: data.last_activity, gate: data.gate ?? null,
    summary: { state, as_of: asOf, newer: newer.slice(0, 20), text, chars: text?.length ?? 0 },
    tasks: {
      counts,
      active: tasks.filter((t) => !CLOSED.includes(t.data.state)).map((t) => ({
        id: t.data.id, state: t.data.state, kind: t.data.kind, phase: t.data.phase ?? null, title: t.data.title, updated: t.data.updated,
      })),
      last_done: done ? { id: done.data.id, title: done.data.title, updated: done.data.updated } : null,
    },
    findings: {
      counts: Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.data.severity === s).length]).filter(([, n]) => n)),
      open: findings
        .filter((f) => LISTED_SEVERITIES.includes(f.data.severity))
        .sort((a, b) => SEVERITIES.indexOf(a.data.severity) - SEVERITIES.indexOf(b.data.severity) || b.data.id.localeCompare(a.data.id))
        .slice(0, LIST_MAX)
        .map((f) => ({ id: f.data.id, severity: f.data.severity, state: f.data.state, title: f.data.title })),
    },
    decisions: {
      total: decisions.length,
      recent: [...decisions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, LIST_MAX).map(({ id, date, title }) => ({ id, date, title })),
    },
  };
}
