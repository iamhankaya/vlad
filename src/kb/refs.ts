import { readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { listMdFiles } from "./archive.js";
import { loadConfig } from "./config.js";
import { scanDecisions } from "./decisions.js";
import { parseDoc, readDoc } from "./doc.js";
import { getKbRecord } from "./get.js";
import { kbPaths } from "./home.js";
import { fencedLines } from "./sections.js";
import { runGitRaw, isRepo } from "../git/git.js";

export type RefType = "task" | "finding" | "decision" | "journal" | "project";

export interface RefMention {
  type: RefType;
  /** id of the mentioning record (`journal:<date>#<project>` for journal sections) */
  id: string;
  status: string | null;
  date: string | null;
  /** full timestamp (ordering and fixed/open comparison); `date` is display only */
  ts: string | null;
  /** nearest heading line above the mention (`### Açık noktalar`), "" when none */
  section: string;
  /** nearest `## ` heading line above the mention */
  h2: string;
  snippet: string;
  path: string;
  relative: string;
}
export interface RefCommit { sha: string; date: string; subject: string; repo: string }
export interface RefFlag { code: "fixed_but_open_in_report" | "open_but_done_in_report"; message: string; evidence: string[] }
export interface RefsResult {
  id: string;
  type: "task" | "finding" | "decision";
  status: string | null;
  project: string | null;
  mentions: RefMention[];
  commits: RefCommit[];
  flags: RefFlag[];
  warnings: string[];
}

const ID_RE = /^(T\d{8}-\d{2,}|F-[a-z0-9-]+-\d+|D-[a-z0-9-]+-\d+)$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The id as a whole token: F-vlad-10 must not match inside F-vlad-100 or xF-vlad-10. */
const tokenRe = (id: string) => new RegExp(`(?<![A-Za-z0-9-])${escapeRe(id)}(?![A-Za-z0-9])`);
const SNIPPET = 160;
const OPEN_POINTS = /^#{3,}\s+Açık noktalar\b/;
const DONE_LIST = /^#{3,}\s+Yapılanlar\b/;

interface Source { type: RefType; id: string; status: string | null; date: string | null; text: string; path: string }

function* sources(): Generator<Source> {
  const p = kbPaths();
  for (const path of listMdFiles(p.tasks)) {
    try {
      const { data, body } = parseDoc<{ id?: string; state?: string; updated?: string }>(readFileSync(path, "utf8"));
      yield { type: "task", id: data.id ?? basename(path, ".md"), status: data.state ?? null, date: data.updated ?? null, text: body, path };
    } catch { /* unreadable files are reported by `task list` */ }
  }
  for (const path of listMdFiles(p.findings)) {
    try {
      const { data, body } = parseDoc<{ id?: string; state?: string; updated?: string }>(readFileSync(path, "utf8"));
      yield { type: "finding", id: data.id ?? basename(path, ".md"), status: data.state ?? null, date: data.updated ?? null, text: body, path };
    } catch { /* see above */ }
  }
  let n = 0;
  for (const { rec, text } of scanDecisions()) {
    yield { type: "decision", id: rec.id || `${rec.file}#${rec.date}#${n++}`, status: rec.id ? rec.status : null, date: rec.date, text, path: rec.path };
  }
  for (const path of listMdFiles(p.journal)) yield { type: "journal", id: `journal:${basename(path, ".md")}`, status: null, date: basename(path, ".md"), text: readFileSync(path, "utf8"), path };
  for (const path of listMdFiles(p.projects)) {
    try {
      const { data, body } = parseDoc<{ slug?: string; last_activity?: string | null }>(readFileSync(path, "utf8"));
      yield { type: "project", id: data.slug ?? basename(path, ".md"), status: null, date: data.last_activity ?? null, text: body, path };
    } catch { /* see above */ }
  }
}

/** Epoch ms of a (possibly date-only, possibly offset) timestamp; unparseable/missing sorts first. */
function tsMs(t: string | null): number {
  const n = t ? Date.parse(t) : NaN;
  return Number.isNaN(n) ? -Infinity : n;
}

function mentionsOf(id: string): RefMention[] {
  const re = tokenRe(id);
  const kb = kbPaths().kb;
  const out: RefMention[] = [];
  for (const s of sources()) {
    if (s.id === id) continue; // a record's own file/block is not a reference
    const lines = s.text.replace(/\r\n/g, "\n").split("\n");
    const fenced = fencedLines(lines);
    let h2 = "";
    let heading = "";
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      if (!fenced[i] && /^#{1,6} /.test(l)) {
        heading = l.trimEnd();
        if (/^## /.test(l)) h2 = heading;
        else if (/^# /.test(l)) h2 = "";
      }
      if (!re.test(l)) return;
      const key = heading; // one mention per record and section
      if (seen.has(key)) return;
      seen.add(key);
      const at = Math.max(0, l.search(re) - 40);
      out.push({
        type: s.type, id: s.id, status: s.status, date: s.date && s.date.slice(0, 10), ts: s.date, section: heading, h2,
        snippet: l.slice(at, at + SNIPPET).replace(/\s+/g, " ").trim(),
        path: s.path, relative: relative(kb, s.path).split("\\").join("/"),
      });
    });
  }
  return out.sort((a, b) => tsMs(a.ts) - tsMs(b.ts) || a.id.localeCompare(b.id));
}

/** Local clones to try, in order: the card's `path`, then `<root>/<slug>` for each configured root. */
function cloneCandidates(project: string): string[] {
  const out: string[] = [];
  try {
    const { data } = readDoc<{ path?: string }>(join(kbPaths().projects, `${project}.md`));
    if (data.path) out.push(data.path);
  } catch { /* no card: roots only */ }
  try { for (const r of loadConfig().roots ?? []) out.push(join(r, project)); } catch { /* unreadable config is reported elsewhere */ }
  return out;
}

function commitsOf(id: string, project: string | null, warnings: string[]): RefCommit[] {
  if (!project) { warnings.push("proje bilinmiyor: commit araması atlandı"); return []; }
  const dir = cloneCandidates(project).find((d) => { try { return statSync(d).isDirectory() && isRepo(d); } catch { return false; } });
  if (!dir) { warnings.push(`${project}: yerel klon bulunamadı, commit araması atlandı`); return []; }
  const raw = runGitRaw(dir, ["log", "--all", "--fixed-strings", `--grep=${id}`, "--format=%H%x1f%cI%x1f%B%x1e"], 20000);
  if (raw === null) { warnings.push(`${project}: git log başarısız (${dir}), commit araması atlandı`); return []; }
  const re = tokenRe(id);
  const out: RefCommit[] = [];
  for (const rec of raw.split("\x1e")) {
    const [sha, date, msg = ""] = rec.replace(/^\n/, "").split("\x1f");
    if (!sha || !re.test(msg)) continue;
    out.push({ sha, date, subject: msg.split("\n")[0].trim(), repo: dir });
  }
  return out;
}

function flagsOf(rec: { type: string; status: string | null; updated: string | null }, mentions: RefMention[], commits: RefCommit[]): RefFlag[] {
  if (rec.type !== "finding") return [];
  const flags: RefFlag[] = [];
  const reports = mentions.filter((m) => m.type === "task" && /Kapanış raporu/.test(m.h2));
  const last = reports.length ? reports[reports.length - 1] : null; // mentions are in date order
  const where = (m: RefMention) => `${m.id} ${m.section} (${m.date ?? "-"})`;
  // a report older than the fix is the finding's origin, not a contradiction
  if ((rec.status === "fixed" || rec.status === "wontfix") && last && OPEN_POINTS.test(last.section) && tsMs(last.ts) > tsMs(rec.updated)) {
    flags.push({ code: "fixed_but_open_in_report", message: `bulgu ${rec.status} ama son rapor atfı Açık noktalar'da`, evidence: [where(last)] });
  }
  if (rec.status === "open" || rec.status === "deferred") {
    const done = mentions.filter((m) => m.type === "task" && DONE_LIST.test(m.section));
    if (done.length || commits.length) {
      flags.push({
        code: "open_but_done_in_report", message: `bulgu ${rec.status} ama raporda Yapılanlar'da ya da commit'te geçiyor`,
        evidence: [...done.map(where), ...commits.map((c) => `commit ${c.sha.slice(0, 8)} ${c.subject}`)],
      });
    }
  }
  return flags;
}

/** Structured reference index of one id: who mentions it (section, status, date), commits that name it, contradiction flags. */
export function refsOf(id: string): RefsResult {
  if (!ID_RE.test(id)) throw new Error(`geçersiz ID: ${id} (görev T<YYYYMMDD>-<NN>, bulgu F-<proje>-<NNN> ya da karar D-<proje>-<NNN>)`);
  let type: RefsResult["type"];
  let status: string | null;
  let project: string | null;
  let updated: string | null = null;
  if (id.startsWith("D-")) {
    const d = scanDecisions().find(({ rec }) => rec.id === id);
    if (!d) throw new Error(`kayıt bulunamadı: ${id}`);
    type = "decision"; status = d.rec.status; project = id.replace(/^D-(.+)-\d+$/, "$1"); updated = d.rec.date;
  } else {
    const r = getKbRecord(id);
    type = r.kind; status = (r.data.state as string) ?? null; project = (r.data.project as string) ?? null; updated = (r.data.updated as string) ?? null;
  }
  const warnings: string[] = [];
  const mentions = mentionsOf(id);
  const commits = commitsOf(id, project, warnings);
  return { id, type, status, project, mentions, commits, flags: flagsOf({ type, status, updated }, mentions, commits), warnings };
}

export function formatRefs(r: RefsResult): string {
  const lines = [`${r.id}  ${r.type}  ${r.status ?? "-"}  ${r.project ?? "-"}`];
  lines.push(`atıflar (${r.mentions.length}):`);
  for (const m of r.mentions) lines.push(`  ${m.date ?? "-"}  ${m.type}  ${m.id}  ${m.status ?? "-"}  ${m.section || "-"}\n    ${m.snippet}`);
  lines.push(`commit'ler (${r.commits.length}):`);
  for (const c of r.commits) lines.push(`  ${c.date.slice(0, 10)}  ${c.sha.slice(0, 8)}  ${c.subject}`);
  for (const f of r.flags) lines.push(`ÇELİŞKİ: ${f.message}\n  ${f.evidence.join("\n  ")}`);
  for (const w of r.warnings) lines.push(`uyarı: ${w}`);
  return lines.join("\n");
}
