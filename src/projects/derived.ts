import { readdirSync } from "node:fs";
import { join } from "node:path";
import { listFindingsWithWarnings, SEVERITIES, UNRESOLVED } from "../findings/store.js";
import { kbPaths, listDecisions, readDoc, replaceDerivedBlock, setSection, validate, wrapDerived, writeDoc } from "../kb/index.js";
import type { ProjectCard } from "../kb/index.js";
import { listTasksWithWarnings } from "../tasks/store.js";

const OPEN_HEADING = "## Açık konular";
const ACTIVITY_HEADING = "## Son aktivite";
const ACTIVITY_MAX = 10;
const TITLE_MAX = 100;
const clip = (s: string): string => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s);

/** open+deferred findings, severity first (kritik on top), newest id first within a severity. */
function openFindingsBlock(slug: string): string {
  const { findings } = listFindingsWithWarnings({ project: slug, state: [...UNRESOLVED] });
  const rows = findings
    .sort((a, b) => SEVERITIES.indexOf(a.data.severity) - SEVERITIES.indexOf(b.data.severity) || b.data.id.localeCompare(a.data.id))
    .map((f) => `- ${f.data.id} [${f.data.severity}${f.data.state === "deferred" ? ", ertelendi" : ""}] ${clip(f.data.title)}`);
  return rows.length ? rows.join("\n") : "- (açık bulgu yok)";
}

/** Latest done tasks and valid decisions. shortcut: decisions carry a date only (sorted as end of that day); `task digested` re-stamps a task's `updated`, which moves its date. */
function activityBlock(slug: string): string {
  const events: { key: string; id: string; line: string }[] = [];
  for (const t of listTasksWithWarnings({ project: slug, state: ["done"] }).tasks) {
    events.push({ key: t.data.updated, id: t.data.id, line: `- ${t.data.updated.slice(0, 10)} ${t.data.id} ${clip(t.data.title)}` });
  }
  for (const d of listDecisions({ project: slug })) {
    events.push({ key: `${d.date}T23:59:59`, id: d.id, line: `- ${d.date} ${d.id} ${clip(d.title)} (karar)` });
  }
  const rows = events.sort((a, b) => b.key.localeCompare(a.key) || b.id.localeCompare(a.id)).slice(0, ACTIVITY_MAX).map((e) => e.line);
  return rows.length ? rows.join("\n") : "- (kayıt yok)";
}

/**
 * Regenerates the card's derived blocks: the open-findings block inside `## Açık konular` (hand-written text around it stays)
 * and `## Son aktivite`, which is derived entirely (hand-written lines are dropped: they went stale, records are the truth).
 * Returns whether the card changed; an up-to-date card is not rewritten.
 */
export function refreshProject(slug: string): boolean {
  const file = join(kbPaths().projects, `${slug}.md`);
  const { data, body } = readDoc<ProjectCard>(file);
  validate("project", data);
  let next = replaceDerivedBlock(body, "open-findings", openFindingsBlock(slug), OPEN_HEADING);
  next = setSection(next, ACTIVITY_HEADING, wrapDerived("recent-activity", activityBlock(slug)));
  if (next === body) return false;
  writeDoc(file, data, next);
  return true;
}

/** Refreshes every card; an unreadable card is reported, not fatal. */
export function refreshAllProjects(): { refreshed: string[]; warnings: string[] } {
  const refreshed: string[] = [];
  const warnings: string[] = [];
  for (const f of readdirSync(kbPaths().projects).filter((n) => n.endsWith(".md")).sort()) {
    try {
      if (refreshProject(f.slice(0, -3))) refreshed.push(f.slice(0, -3));
    } catch (e) {
      warnings.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { refreshed, warnings };
}
