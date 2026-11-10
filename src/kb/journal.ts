import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { readText } from "./doc.js";
import { kbPaths } from "./home.js";
import { fencedLines } from "./sections.js";

/** Appends `text` to `file`, keeping exactly one blank line between existing content and the new block. */
function appendBlock(file: string, text: string, initial = ""): void {
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readText(file) : initial;
  const base = cur.replace(/\s+$/, "");
  writeFileAtomic(file, `${base ? base + "\n\n" : ""}${text.replace(/\s+$/, "")}\n`);
}

/** File name (without `.md`) a decision of `project` goes to: its slug, or `_genel` for general/odd project names. */
export function decisionFileFor(project: string): string {
  return /^[a-z0-9][a-z0-9-]*$/.test(project) && project !== "genel" ? project : "_genel";
}

export const decisionTitle = (slug: string): string => `# Karar Günlüğü — ${slug}`;

/** Splits `md` into the text before its first `## ` heading and its `## ` sections (headings in code fences are text). */
function splitSections(md: string): { pre: string; sections: { heading: string; body: string }[] } {
  const lines = md.split("\n");
  const fenced = fencedLines(lines);
  let pre = "";
  const sections: { heading: string; body: string }[] = [];
  for (const [i, line] of lines.entries()) {
    if (!fenced[i] && /^## /.test(line)) sections.push({ heading: line.trimEnd(), body: "" });
    else if (sections.length) sections[sections.length - 1].body += line + "\n";
    else pre += line + "\n";
  }
  return { pre: pre.trim(), sections: sections.map((s) => ({ heading: s.heading, body: s.body.trim() })) };
}

/** Inserts `body` at the end of the existing `heading` section of `text`; null when the day has no such section. */
function mergeIntoSection(text: string, heading: string, body: string): string | null {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const start = lines.map((l, i) => !fenced[i] && l.trimEnd() === heading).lastIndexOf(true); // last match: older files may repeat a heading
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && !fenced[i] && /^## /.test(l));
  if (end < 0) end = lines.length;
  while (end - 1 > start && lines[end - 1].trim() === "") end--;
  const tail = lines.slice(end).join("\n").replace(/^\n+/, "");
  const head = lines.slice(0, end).join("\n");
  return `${head}\n${body}\n${tail ? "\n" + tail : ""}`.replace(/\n*$/, "\n");
}

/**
 * Appends to kb/journal/<date>.md; a missing day is created with a `# <date>` heading. A `## <project>` section
 * whose heading the day already has is merged: its items go to the end of that section instead of a duplicate heading.
 */
export function appendJournal(date: string, md: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`geçersiz tarih: "${date}" (YYYY-MM-DD bekleniyor)`);
  const file = join(kbPaths().journal, `${date}.md`);
  const { pre, sections } = splitSections(md.replace(/\r\n/g, "\n"));
  if (!existsSync(file) || !sections.length) {
    appendBlock(file, md.replace(/\r\n/g, "\n"), `# ${date}`);
    return;
  }
  let text = readText(file).replace(/\r\n/g, "\n");
  const fresh: string[] = [];
  for (const s of sections) {
    const merged = s.body ? mergeIntoSection(text, s.heading, s.body) : null;
    if (merged !== null) text = merged;
    else if (!s.body && mergeIntoSection(text, s.heading, "") !== null) continue; // empty repeat of an existing heading
    else fresh.push(s.body ? `${s.heading}\n${s.body}` : s.heading);
  }
  const rest = [pre, ...fresh].filter(Boolean).join("\n\n");
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, text.replace(/\s+$/, "") + "\n");
  if (rest) appendBlock(file, rest, `# ${date}`);
}

/** One `## <project>` block of a day's journal (content without the heading line). */
export interface JournalSection { project: string; content: string }

/** Reads kb/journal/<date>.md (read-only): the whole text plus its `## ` sections. */
export function getJournal(date: string): { date: string; file: string; content: string; sections: JournalSection[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`geçersiz tarih: "${date}" (YYYY-MM-DD bekleniyor)`);
  const file = join(kbPaths().journal, `${date}.md`);
  if (!existsSync(file)) throw new Error(`günlük yok: ${date}`);
  const content = readText(file).replace(/\r\n/g, "\n");
  const sections: JournalSection[] = [];
  const lines = content.split("\n");
  const fenced = fencedLines(lines); // a "## " line inside a code fence is text, not a heading (F-vlad-098)
  for (const [i, line] of lines.entries()) {
    const h = fenced[i] ? null : /^## (.+)$/.exec(line);
    if (h) sections.push({ project: h[1].trim(), content: "" });
    else if (sections.length) sections[sections.length - 1].content += line + "\n";
  }
  for (const s of sections) s.content = s.content.trim();
  return { date, file, content, sections };
}
