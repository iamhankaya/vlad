import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { kbPaths } from "./home.js";
import { nowIso } from "./time.js";

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

/** Spec 5.4: appends a `### <date> — <project> — <title>` block to kb/decisions/<project>.md. */
export function addDecision(
  o: { project: string; title: string; body: string; source?: string },
  now: Date = new Date(),
): void {
  const head = `### ${nowIso(now).slice(0, 10)} — ${o.project} — ${o.title}`;
  const body = o.body.replace(/\r\n/g, "\n").trim();
  const source = o.source ? `\n- **Kaynak:** ${o.source}` : "";
  const slug = decisionFileFor(o.project);
  appendBlock(join(kbPaths().decisions, `${slug}.md`), `${head}\n${body}${source}`, decisionTitle(slug));
}

/** Appends to kb/journal/<date>.md; a missing day is created with a `# <date>` heading. */
export function appendJournal(date: string, md: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`geçersiz tarih: "${date}" (YYYY-MM-DD bekleniyor)`);
  appendBlock(join(kbPaths().journal, `${date}.md`), md.replace(/\r\n/g, "\n"), `# ${date}`);
}
