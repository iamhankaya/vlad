import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listFindingsWithWarnings, SEVERITIES, UNRESOLVED } from "../findings/store.js";
import { kbPaths, listDecisions, readDoc, derivedOpen, hasSection, replaceDerivedBlock, setDerivedSection, validate, writeFileAtomic } from "../kb/index.js";
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
 * and the `## Son aktivite` block. Text outside the blocks is never touched: an explicit refresh migrates a card without the Son aktivite block by putting the block at the top of the section, hand-written lines stay below it.
 * `create: false` (automatic hooks) only refreshes blocks that already exist (open findings: also fills a missing block in an existing section; Son aktivite: needs the block) and never adds a section; `only` limits the work to one block (a `finding set` need not scan the tasks). Returns whether the card changed; an up-to-date card is not rewritten.
 */
export function refreshProject(slug: string, opts: { create?: boolean; only?: "findings" | "activity" } = {}): boolean {
  const file = join(kbPaths().projects, `${slug}.md`);
  const { data } = readDoc<ProjectCard>(file); // validates and refuses symlinks
  validate("project", data);
  // raw text: frontmatter, EOL and everything outside the blocks stay byte for byte
  const raw = readFileSync(file, "utf8");
  const head = /^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(raw)?.[0] ?? "";
  const rest = raw.slice(head.length);
  // automatic refresh (create: false) only fills blocks/sections the card already has, and then reads no records for the others
  const wants = (name: string, heading: string) =>
    (!opts.only || (opts.only === "findings") === (name === "open-findings")) &&
    (opts.create !== false || rest.includes(derivedOpen(name)) || (name === "open-findings" && hasSection(rest, heading)));
  let next = rest;
  if (wants("open-findings", OPEN_HEADING)) next = replaceDerivedBlock(next, "open-findings", openFindingsBlock(slug), OPEN_HEADING);
  if (wants("recent-activity", ACTIVITY_HEADING)) next = setDerivedSection(next, "recent-activity", activityBlock(slug), ACTIVITY_HEADING);
  if (next === rest) return false;
  writeFileAtomic(file, head + next);
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
