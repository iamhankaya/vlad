import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kbPaths } from "./home.js";
import { nowIso } from "./time.js";

/** Appends `text` to `file`, keeping exactly one blank line between existing content and the new block. */
function appendBlock(file: string, text: string, initial = ""): void {
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, "utf8") : initial;
  const base = cur.replace(/\s+$/, "");
  writeFileSync(file, `${base ? base + "\n\n" : ""}${text.replace(/\s+$/, "")}\n`, "utf8");
}

/** Spec 5.4: appends a `### <date> — <project> — <title>` block to kb/decisions.md. */
export function addDecision(
  o: { project: string; title: string; body: string; source?: string },
  now: Date = new Date(),
): void {
  const head = `### ${nowIso(now).slice(0, 10)} — ${o.project} — ${o.title}`;
  const body = o.body.replace(/\r\n/g, "\n").trim();
  const source = o.source ? `\n- **Kaynak:** ${o.source}` : "";
  appendBlock(kbPaths().decisions, `${head}\n${body}${source}`);
}

/** Appends to kb/journal/<date>.md; a missing day is created with a `# <date>` heading. */
export function appendJournal(date: string, md: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`geçersiz tarih: "${date}" (YYYY-MM-DD bekleniyor)`);
  appendBlock(join(kbPaths().journal, `${date}.md`), md.replace(/\r\n/g, "\n"), `# ${date}`);
}
