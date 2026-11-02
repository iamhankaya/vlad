import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { projectStatus } from "../projects/status.js";
import { listProjects } from "../projects/store.js";
import { loadConfig } from "./config.js";
import { DECISION_HEADING, listDecisions } from "./decisions.js";
import { derivedLines } from "./derived.js";
import { getVladHome, kbPaths } from "./home.js";
import { recordStates } from "./refs.js";
import type { RecordState } from "./refs.js";
import { fencedLines } from "./sections.js";

export const LINT_CODES = [
  "closed_finding_listed_open", "finished_task_listed_active", "inactive_decision_listed_valid",
  "expired_decision_valid", "memory_stale_task", "summary_stale",
] as const;
export type LintCode = (typeof LINT_CODES)[number];

export interface LintFlag {
  code: LintCode;
  /** path relative to the kb (`projects/vlad.md`); absolute for memory files */
  file: string;
  /** 1-based line in `file` */
  line: number;
  /** the record the flag is about (T…/F-…/D-…, or the project slug for `summary_stale`) */
  id: string;
  /** state of that record in the kb (`fixed`, `done`, `geçersiz`, `bayat`, ...) */
  actual_state: string;
  message: string;
  suggestion: string;
  /** project the flag is grouped under; null when unknown (memory notes naming no known record) */
  project: string | null;
}
export interface LintResult {
  flags: LintFlag[];
  counts: Partial<Record<LintCode, number>>;
  scanned: { projects: number; decisions: number; memory: number };
  warnings: string[];
}

const L = "(?<![\\p{L}])";
const R = "(?![\\p{L}])";
const words = (...w: string[]) => new RegExp(`${L}(?:${w.join("|")})${R}`, "iu");
/** The record is still open/pending (present tense; "açıktı" etc. is narrative and does not match). */
const OPEN_CTX = words("açık", "bekliyor", "bekleyen", "yapılacak", "ertelen\\p{L}*", "open", "pending", "todo", "outstanding");
/** A task is still going. */
const ACTIVE_CTX = words("sürüyor", "devam ediyor", "çalışıyor", "bekliyor", "onay bekliyor", "yürütülüyor", "aktif", "running", "in progress");
/** Wording that says the record is closed/over: the line is a statement about the past or the end state. */
const CLOSED_CTX = words("kapan\\p{L}*", "kapat\\p{L}*", "düzel\\p{L}*", "düzelt\\p{L}*", "çözül\\p{L}*", "giderildi", "tamamlan\\p{L}*", "bitti", "bitmiş", "merge edil\\p{L}*", "iptal\\p{L}*", "fixed", "resolved", "closed", "done", "wontfix", "cancelled", "geçersiz\\p{L}*");
/** Permission/plan wording tied to a task in a memory note. */
const AUTHORITY_CTX = words("yalnız", "sadece", "only", "çatı\\p{L}*", "bitince", "bitene kadar", "tamamlanınca", "tamamlanana kadar", "yetki\\p{L}*", "izin\\p{L}*", "onay\\p{L}*", "plan\\p{L}*", "sormadan", "istenecek", "sorulacak");
const VALID_LIST_CTX = words("geçerli kararlar?", "geçerli olan kararlar", "valid decisions");
const INACTIVE_WORDS = words("geçersiz\\p{L}*", "yerine geçti", "yerine-geçti", "iptal\\p{L}*", "kaldırıl\\p{L}*", "superseded", "invalid", "geçerli karar değil", "geçerli değil");
const DATE_LED = /^\s*(?:[-*]\s*)?(?:\*\*)?_?\d{4}-\d{2}-\d{2}/;
const ID_G = /(?<![A-Za-z0-9-])(T\d{8}-\d{2,}|F-[a-z0-9-]+-\d+|D-[a-z0-9-]+-\d+)(?![A-Za-z0-9])/g;
/** "… 2026-10-28 08:00'e kadar", "… 2026-10-28'e kadar" */
const EXPIRY_TR = /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?['’]?(?:y?[ea])?\s+(?:kadar|dek)(?![\p{L}])/giu;
const EXPIRY_EN = /(?:until|through|expires?(?: on)?)\s+(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/gi;

const rel = (kb: string, p: string) => relative(kb, p).split("\\").join("/");
const linesOf = (text: string) => text.replace(/\r\n/g, "\n").split("\n");

interface TextLine { n: number; text: string; h2: string; /** bullet/line sits inside a "geçerli kararlar" list */ listing: boolean }

/** Human-written lines of a text: fenced code and derived blocks are skipped; each carries its `## ` section and list context. */
function* textLines(lines: string[]): Generator<TextLine> {
  const fenced = fencedLines(lines);
  const derived = derivedLines(lines);
  let h2 = "";
  let listing = false;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || derived[i]) continue;
    const t = lines[i];
    if (/^#{1,6} /.test(t)) {
      if (/^## /.test(t)) h2 = t.replace(/^## /, "").trim();
      listing = VALID_LIST_CTX.test(t);
      continue;
    }
    if (!t.trim()) { listing = false; continue; }
    const bullet = /^\s*(?:[-*]|\d+[.)])\s/.test(t);
    if (VALID_LIST_CTX.test(t)) listing = true;
    else if (!bullet) listing = false;
    yield { n: i + 1, text: t, h2, listing };
  }
}

/** The sentence/clause of `line` holding offset `at` (boundaries: ". ", "; ", " — "). */
function sentenceAt(line: string, at: number): string {
  const cut = /(?<=[.;!?])\s+|\s[—–]\s/g;
  let start = 0;
  for (const m of line.matchAll(cut)) {
    const end = m.index ?? 0;
    if (at < end) return line.slice(start, end);
    start = end + m[0].length;
  }
  return line.slice(start);
}

interface Ctx { file: string; project: string | null; kind: "card" | "decision" | "memory"; own?: string }

function lineFlags(tl: TextLine, ctx: Ctx, states: Map<string, RecordState>, push: (f: Omit<LintFlag, "file" | "project">) => void): void {
  const inOpenSection = /^Açık konular\b/i.test(tl.h2);
  const narrative = /^Son aktivite\b/i.test(tl.h2) && DATE_LED.test(tl.text);
  const seen = new Set<string>();
  for (const m of tl.text.matchAll(ID_G)) {
    const id = m[1];
    const st = states.get(id);
    if (!st || id === ctx.own || seen.has(id)) continue;
    seen.add(id);
    const text = sentenceAt(tl.text, m.index ?? 0); // keywords count only in the sentence that holds the id
    const closed = CLOSED_CTX.test(text);
    const status = st.status ?? "";
    if (st.type === "finding" && (status === "fixed" || status === "wontfix")) {
      if (inOpenSection || (!narrative && !closed && OPEN_CTX.test(text))) {
        push({ code: "closed_finding_listed_open", line: tl.n, id, actual_state: status, message: `${id} ${status} ama ${inOpenSection ? "Açık konular'da" : "açık/bekliyor bağlamında"} geçiyor`, suggestion: `satırı kaldır ya da "${id} kapandı" diye geçmişe çevir (özet: /digest)` });
      }
    } else if (st.type === "task" && (status === "done" || status === "cancelled")) {
      if (ctx.kind === "memory") {
        if (AUTHORITY_CTX.test(text)) push({ code: "memory_stale_task", line: tl.n, id, actual_state: status, message: `hafıza notu ${status} göreve (${id}) bağlı yetki/plan içeriyor`, suggestion: "notu sil ya da güncelle (görev bittiği için artık geçerli olmayabilir)" });
      } else if (inOpenSection || (!narrative && !closed && ACTIVE_CTX.test(text))) {
        push({ code: "finished_task_listed_active", line: tl.n, id, actual_state: status, message: `${id} ${status} ama ${inOpenSection ? "Açık konular'da" : "sürüyor/bekliyor bağlamında"} geçiyor`, suggestion: `satırı kaldır ya da "${id} ${status === "done" ? "tamamlandı" : "iptal edildi"}" diye geçmişe çevir` });
      }
    } else if (st.type === "decision" && (status === "geçersiz" || status === "yerine-geçti")) {
      if (tl.listing && !INACTIVE_WORDS.test(text)) {
        push({ code: "inactive_decision_listed_valid", line: tl.n, id, actual_state: status, message: `${id} ${status} ama geçerli kararlar listesinde`, suggestion: "listeden çıkar (geçerli liste: vlad decision list --project <slug>)" });
      }
    }
  }
}

/** Latest "kadar"-style deadline in a decision block, or null. */
function latestExpiry(lines: string[], from: number, to: number): { at: Date; line: number } | null {
  const fenced = fencedLines(lines);
  let best: { at: Date; line: number } | null = null;
  for (let i = from; i < to; i++) {
    if (fenced[i]) continue;
    for (const re of [EXPIRY_TR, EXPIRY_EN]) {
      re.lastIndex = 0;
      for (const m of lines[i].matchAll(re)) {
        const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
        const at = m[4] === undefined ? new Date(y, mo - 1, d, 23, 59, 59, 999) : new Date(y, mo - 1, d, Number(m[4]), Number(m[5]));
        if (!Number.isNaN(at.getTime()) && (!best || at > best.at)) best = { at, line: i + 1 };
      }
    }
  }
  return best;
}

function memoryFiles(dirs: string[], home: string, warnings: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    const dir = isAbsolute(d) ? d : resolve(home, d);
    try {
      if (!statSync(dir).isDirectory()) throw new Error("klasör değil");
      for (const n of readdirSync(dir).sort()) if (n.endsWith(".md")) out.push(join(dir, n));
    } catch {
      warnings.push(`memoryDirs: ${dir} okunamadı, atlandı`);
    }
  }
  return out;
}

export interface LintOptions { project?: string; /** injectable clock (tests) */ now?: Date }

/** Read-only contradiction check of the kb's prose against the records it names. */
export function lintKb(o: LintOptions = {}): LintResult {
  const p = kbPaths();
  const now = o.now ?? new Date();
  const warnings: string[] = [];
  const states = recordStates();
  const flags: LintFlag[] = [];
  const scanned = { projects: 0, decisions: 0, memory: 0 };
  const cards = existsSync(p.projects) ? readdirSync(p.projects).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).sort() : [];
  if (o.project && !cards.includes(o.project)) throw new Error(`proje kartı bulunamadı: ${o.project}`);
  const mk = (ctx: Ctx, file: string) => (f: Omit<LintFlag, "file" | "project">) => { flags.push({ ...f, file, project: ctx.project }); };

  for (const slug of o.project ? [o.project] : cards) {
    const path = join(p.projects, `${slug}.md`);
    const lines = linesOf(readFileSync(path, "utf8"));
    scanned.projects++;
    const ctx: Ctx = { file: path, project: slug, kind: "card" };
    for (const tl of textLines(lines)) lineFlags(tl, ctx, states, mk(ctx, rel(p.kb, path)));
    const active = listProjects().find((x) => x.slug === slug)?.status === "active";
    if (active) {
      try {
        const s = projectStatus(slug).summary;
        if (s.state !== "güncel") {
          const at = lines.findIndex((l) => l.trimEnd() === "## Durum özeti");
          const newer = s.newer.length ? `; sonrasında: ${s.newer.slice(0, 5).join(", ")}${s.newer.length > 5 ? ", …" : ""}` : "";
          mk(ctx, rel(p.kb, path))({
            code: "summary_stale", line: at >= 0 ? at + 1 : 1, id: slug, actual_state: s.state,
            message: s.state === "yok" ? "Durum özeti yok" : `Durum özeti bayat (${s.as_of ?? "tarihsiz"})${newer}`,
            suggestion: "/digest ile özeti güncelle (vlad project summary <slug> --file …)",
          });
        }
      } catch (e) { warnings.push(`${slug}: özet tazeliği okunamadı: ${(e as Error).message}`); }
    }
  }

  const decisionStatus = new Map(listDecisions({ all: true }).map((d) => [d.id, d.status] as const));
  const decisionFiles = existsSync(p.decisions) ? readdirSync(p.decisions).filter((n) => n.endsWith(".md")).sort() : [];
  for (const name of decisionFiles) {
    const slug = name.slice(0, -3) === "_genel" ? "genel" : name.slice(0, -3);
    if (o.project && slug !== o.project) continue;
    const path = join(p.decisions, name);
    const lines = linesOf(readFileSync(path, "utf8"));
    scanned.decisions++;
    const heads = lines.map((l, i) => (DECISION_HEADING.test(l) ? i : -1)).filter((i) => i >= 0);
    const ownAt = (i: number) => { const h = heads.filter((x) => x <= i).pop(); return h === undefined ? undefined : /^- \*\*ID:\*\* (\S+)/.exec(lines.slice(h + 1, h + 6).find((l) => /^- \*\*ID:\*\*/.test(l)) ?? "")?.[1]; };
    const ctx: Ctx = { file: path, project: slug, kind: "decision" };
    const push = mk(ctx, rel(p.kb, path));
    for (const tl of textLines(lines)) lineFlags(tl, { ...ctx, own: ownAt(tl.n - 1) }, states, push);
    heads.forEach((h, k) => {
      const id = ownAt(h);
      if (!id || decisionStatus.get(id) !== "geçerli") return;
      const exp = latestExpiry(lines, h, k + 1 < heads.length ? heads[k + 1] : lines.length);
      if (exp && exp.at < now) {
        push({
          code: "expired_decision_valid", line: exp.line, id, actual_state: "geçerli",
          message: `${id} geçerli ama süresi dolmuş (${exp.at.toISOString().slice(0, 16).replace("T", " ")} UTC'ye kadar)`,
          suggestion: `vlad decision set ${id} geçersiz (süre dolduysa) ya da kararı yeni süreyle yenile`,
        });
      }
    });
  }

  let memDirs: string[] = [];
  try { memDirs = loadConfig().memoryDirs ?? []; } catch (e) { warnings.push(`config okunamadı, hafıza taranmadı: ${(e as Error).message}`); }
  for (const file of memoryFiles(memDirs, getVladHome(), warnings)) {
    scanned.memory++;
    const ctx: Ctx = { file, project: null, kind: "memory" };
    const push = mk(ctx, file);
    const tmp: LintFlag[] = [];
    const before = flags.length;
    for (const tl of textLines(linesOf(readFileSync(file, "utf8")))) lineFlags(tl, ctx, states, push);
    // memory is global: attribute each flag to the project of the record it names
    for (let i = before; i < flags.length; i++) {
      flags[i].project = states.get(flags[i].id)?.project ?? null;
      if (o.project && flags[i].project !== o.project) tmp.push(flags[i]);
    }
    if (tmp.length) for (const f of tmp) flags.splice(flags.indexOf(f), 1);
  }

  flags.sort((a, b) => (a.project ?? "~").localeCompare(b.project ?? "~") || a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code));
  const counts: Partial<Record<LintCode, number>> = {};
  for (const f of flags) counts[f.code] = (counts[f.code] ?? 0) + 1;
  return { flags, counts, scanned, warnings };
}

/** Flags are information (0); `--strict` turns any flag into a failure. Errors throw (CLI exits 1). */
export function lintExitCode(r: LintResult, strict: boolean): number {
  return strict && r.flags.length ? 1 : 0;
}

export function formatLint(r: LintResult): string {
  const lines: string[] = [];
  const groups = new Map<string, LintFlag[]>();
  for (const f of r.flags) groups.set(f.project ?? "(hafıza)", [...(groups.get(f.project ?? "(hafıza)") ?? []), f]);
  for (const [proj, fl] of groups) {
    lines.push(`${proj} (${fl.length})`);
    for (const f of fl) lines.push(`  ${f.code}  ${f.file}:${f.line}  ${f.id} [${f.actual_state}]\n    ${f.message}\n    → ${f.suggestion}`);
  }
  if (!r.flags.length) lines.push("çelişki yok");
  lines.push(`tarandı: ${r.scanned.projects} kart, ${r.scanned.decisions} karar dosyası, ${r.scanned.memory} hafıza dosyası`);
  for (const w of r.warnings) lines.push(`uyarı: ${w}`);
  return lines.join("\n");
}
