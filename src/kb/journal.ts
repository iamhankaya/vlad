import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { kbPaths } from "./home.js";

/** Appends `text` to `file`, keeping exactly one blank line between existing content and the new block. */
function appendBlock(file: string, text: string, initial = ""): void {
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, "utf8") : initial;
  const base = cur.replace(/\s+$/, "");
  writeFileAtomic(file, `${base ? base + "\n\n" : ""}${text.replace(/\s+$/, "")}\n`);
}

/** File name (without `.md`) a decision of `project` goes to: its slug, or `_genel` for general/odd project names. */
export function decisionFileFor(project: string): string {
  return /^[a-z0-9][a-z0-9-]*$/.test(project) && project !== "genel" ? project : "_genel";
}

export const decisionTitle = (slug: string): string => `# Karar Günlüğü — ${slug}`;

/** Appends to kb/journal/<date>.md; a missing day is created with a `# <date>` heading. */
export function appendJournal(date: string, md: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`geçersiz tarih: "${date}" (YYYY-MM-DD bekleniyor)`);
  appendBlock(join(kbPaths().journal, `${date}.md`), md.replace(/\r\n/g, "\n"), `# ${date}`);
}

/** One `## <project>` block of a day's journal (content without the heading line). */
export interface JournalSection { project: string; content: string }

/** Reads kb/journal/<date>.md (read-only): the whole text plus its `## ` sections. */
export function getJournal(date: string): { date: string; file: string; content: string; sections: JournalSection[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`geçersiz tarih: "${date}" (YYYY-MM-DD bekleniyor)`);
  const file = join(kbPaths().journal, `${date}.md`);
  if (!existsSync(file)) throw new Error(`günlük yok: ${date}`);
  const content = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const sections: JournalSection[] = [];
  for (const line of content.split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) sections.push({ project: h[1].trim(), content: "" });
    else if (sections.length) sections[sections.length - 1].content += line + "\n";
  }
  for (const s of sections) s.content = s.content.trim();
  return { date, file, content, sections };
}
