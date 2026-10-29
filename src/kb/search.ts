import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { listMdFiles } from "./archive.js";
import { scanDecisions } from "./decisions.js";
import { parseDoc } from "./doc.js";
import { kbPaths } from "./home.js";

export const SEARCH_TYPES = ["task", "finding", "decision", "journal"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchHit {
  id: string;
  type: SearchType;
  project: string | null;
  status: string | null;
  date: string | null;
  /** `## ` heading of the matching section (tasks, journal) */
  section?: string;
  snippet: string;
  /** real absolute path (archive included) */
  path: string;
  relative: string;
}

/** Per character, so offsets in the folded text are offsets in the original: İ/I/ı -> i, lower case, diacritics dropped (ş->s, ğ->g, ü->u, ö->o, ç->c). */
export function normalize(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch === "İ" || ch === "I" || ch === "ı" ? "i" : ch.toLowerCase();
    out += c.normalize("NFD")[0];
  }
  return out;
}

/** shortcut: suffix handling is "query word minus its last 3 letters also matches" for words of 7+ letters, no real stemmer; upgrade to a stemmer or FTS if recall proves too low. */
function variants(word: string): string[] {
  return word.length >= 7 ? [word, word.slice(0, -3)] : [word];
}

const SNIPPET = 160;

function snippetOf(text: string, folded: string, words: string[]): string {
  const at = Math.min(...words.map((w) => variants(w).map((v) => folded.indexOf(v)).filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), Infinity)));
  const from = Math.max(0, (Number.isFinite(at) ? at : 0) - 40);
  return text.slice(from, from + SNIPPET).replace(/\s+/g, " ").trim();
}

interface Unit { id: string; type: SearchType; project: string | null; status: string | null; date: string | null; section?: string; title: string; text: string; path: string }

function scoreOf(unit: Unit, words: string[]): number {
  const body = normalize(unit.text);
  const title = normalize(unit.title);
  let score = 0;
  for (const w of words) {
    const vs = variants(w);
    const inBody = vs.some((v) => body.includes(v));
    const inTitle = vs.some((v) => title.includes(v));
    if (!inBody && !inTitle) return 0; // every query word must occur
    score += (inTitle ? 3 : 0) + (inBody ? 1 : 0);
  }
  return score + (unit.type === "decision" && unit.status === "geçerli" ? 4 : 0); // "what did we decide" questions want the current decision first
}

/** `## ` sections of a markdown body (text before the first heading is the "" section). */
function sections(body: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [{ heading: "", text: "" }];
  for (const line of body.split("\n")) {
    if (/^## /.test(line)) out.push({ heading: line.trimEnd(), text: "" });
    else out[out.length - 1].text += line + "\n";
  }
  return out.filter((s) => s.text.trim());
}

function* taskUnits(): Generator<Unit> {
  for (const path of listMdFiles(kbPaths().tasks)) {
    try {
      const { data, body } = parseDoc<{ id?: string; project?: string; title?: string; state?: string; updated?: string }>(readFileSync(path, "utf8"));
      for (const s of sections(body)) {
        yield { id: data.id ?? basename(path, ".md"), type: "task", project: data.project ?? null, status: data.state ?? null, date: data.updated ?? null, section: s.heading || undefined, title: data.title ?? "", text: s.text, path };
      }
    } catch { /* unreadable files are reported by `task list` */ }
  }
}

function* findingUnits(): Generator<Unit> {
  for (const path of listMdFiles(kbPaths().findings)) {
    try {
      const { data, body } = parseDoc<{ id?: string; project?: string; title?: string; state?: string; updated?: string }>(readFileSync(path, "utf8"));
      yield { id: data.id ?? basename(path, ".md"), type: "finding", project: data.project ?? null, status: data.state ?? null, date: data.updated ?? null, title: data.title ?? "", text: body, path };
    } catch { /* see above */ }
  }
}

function* decisionUnits(project?: string): Generator<Unit> {
  for (const { rec, text } of scanDecisions(project)) {
    yield { id: rec.id || `${rec.file}#${rec.date}`, type: "decision", project: rec.file === "_genel" ? null : rec.file, status: rec.id ? rec.status : null, date: rec.date, title: rec.title, text, path: rec.path };
  }
}

function* journalUnits(): Generator<Unit> {
  for (const path of listMdFiles(kbPaths().journal)) {
    const date = basename(path, ".md");
    for (const s of sections(readFileSync(path, "utf8"))) {
      if (!s.heading) continue; // the `# date` title only
      const project = s.heading.slice(3).trim();
      yield { id: `journal:${date}#${project}`, type: "journal", project, status: null, date, section: s.heading, title: "", text: s.text, path };
    }
  }
}

/**
 * Bounded keyword search over the kb files (archive included): tasks per `## ` section, decisions per block,
 * findings whole, journal per `## <project>` section. All query words must occur in the unit; one hit per
 * record (its best unit). First version is a plain file scan, no index.
 */
export function searchKb(o: { query: string; project?: string; type?: string; limit?: number }): SearchHit[] {
  const words = normalize(o.query).split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error("sorgu boş olamaz");
  if (o.type && !(SEARCH_TYPES as readonly string[]).includes(o.type)) throw new Error(`geçersiz tür: ${o.type} (${SEARCH_TYPES.join(" | ")})`);
  const limit = o.limit ?? 8;
  if (!(limit >= 1)) throw new Error(`geçersiz --limit: ${o.limit}`);
  const want = (t: SearchType) => !o.type || o.type === t;
  const kb = kbPaths().kb;
  const best = new Map<string, { unit: Unit; score: number }>();
  const consider = (unit: Unit) => {
    if (o.project && normalize(unit.project ?? "") !== normalize(o.project)) return;
    const score = scoreOf(unit, words);
    if (!score) return;
    const key = `${unit.type}:${unit.id}`;
    if (!best.has(key) || best.get(key)!.score < score) best.set(key, { unit, score });
  };
  if (want("task")) for (const u of taskUnits()) consider(u);
  if (want("finding")) for (const u of findingUnits()) consider(u);
  if (want("decision")) for (const u of decisionUnits(o.project && o.project !== "genel" ? o.project : undefined)) consider(u);
  if (want("journal")) for (const u of journalUnits()) consider(u);
  return [...best.values()]
    .sort((a, b) => b.score - a.score || String(b.unit.date).localeCompare(String(a.unit.date)))
    .slice(0, limit)
    .map(({ unit: u }) => ({
      id: u.id, type: u.type, project: u.project, status: u.status, date: u.date && u.date.slice(0, 10),
      ...(u.section ? { section: u.section } : {}),
      snippet: snippetOf(u.text, normalize(u.text), words),
      path: u.path, relative: relative(kb, u.path).split("\\").join("/"),
    }));
}
