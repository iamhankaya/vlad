import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { getVladHome, isSeparateKb, kbPaths } from "../kb/index.js";

/**
 * Read-only vault access. Virtual allowlist ("/"-separated; the same paths the API and the mobile app use):
 *   kb/        (the kb checkout, which may be its own repo: `kbPaths().kb`) except kb/inbox, kb/logs, kb/grants, kb/audit and any dot-entry
 *   vault/docs/  real root: `<kb>/docs` when the kb is its own repo and that folder exists (S13a K7), else the legacy `<VLAD_HOME>/vault/docs`
 * With a separate kb, `<kb>/docs` is only reachable as vault/docs (kb/docs is refused: no double results).
 * Only *.md files are readable. Every path (input and symlink target) is checked after
 * lower-casing, so case variants cannot reach a forbidden folder.
 */

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_QUERY_CHARS = 256;
export const MAX_PATH_CHARS = 512;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_LS_ENTRIES = 1000;
/** Search budget: exceeding any of these ends the walk with a partial result (truncated: true). */
export const SEARCH_BUDGET = { files: 5000, bytes: 20 * 1024 * 1024, depth: 16, ms: 5000 };
export type SearchBudget = typeof SEARCH_BUDGET;

export type Zone = "kb" | "docs";
export const ZONES: Zone[] = ["kb", "docs"];
const ZONE_ROOT: Record<Zone, string> = { kb: "kb", docs: "vault/docs" };
const FORBIDDEN_UNDER_KB = ["inbox", "logs", "grants", "audit"];
/** Folder of the docs zone inside a separate kb checkout. */
const KB_DOCS_DIR = "docs";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** Any non-VaultError (fs errors carry absolute paths) becomes a fixed message. */
function safe<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError("okunamadı");
  }
}

/** Key for allowlist/denylist comparison: NFKC + upper + lower folds ſ, fullwidth forms, ı/İ variants. */
function denyKey(s: string): string {
  return s.normalize("NFKC").toUpperCase().toLowerCase();
}

export interface Heading { level: number; text: string; line: number }
export interface VaultHit { path: string; score: number; line: number; snippet: string; matches: number }
export interface VaultFile { path: string; content: string; headings: Heading[] }
export interface VaultEntry { path: string; type: "file" | "dir"; size?: number }

/** Turkish-aware, case-insensitive fold: İ ı I -> i, then lower-case. */
export function fold(s: string): string {
  return s.normalize("NFC").replace(/[İıI]/g, "i").toLowerCase();
}

/** Splits an allowlist-relative path into lower-cased segments, or null when not allowed. */
function allowedZone(rel: string[], docsInKb: boolean): Zone | null {
  const low = rel.map(denyKey);
  if (low.some((s) => s.startsWith("."))) return null;
  if (low[0] === "kb") {
    if (low.length > 1 && (FORBIDDEN_UNDER_KB.includes(low[1]) || (docsInKb && low[1] === KB_DOCS_DIR))) return null;
    return "kb";
  }
  if (low[0] === "vault" && low[1] === "docs") return "docs";
  return null;
}

/** Validates a user-supplied vault path; returns normalized segments. */
function parseUserPath(input: string): string[] {
  if (typeof input !== "string" || input.length === 0) throw new VaultError("yol boş");
  if (input.length > MAX_PATH_CHARS) throw new VaultError("yol çok uzun");
  if (input.includes("\0")) throw new VaultError("yol null bayt içeremez");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(input)) throw new VaultError("yol kontrol karakteri içeremez");
  if (input.includes("\\")) throw new VaultError("yol ters eğik çizgi içeremez");
  if (/%[0-9a-fA-F]{2}/.test(input)) throw new VaultError("yol kodlanmış karakter içeremez");
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) throw new VaultError("yol göreli olmalı (mutlak yol reddedildi)");
  const segs = input.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.length === 0) throw new VaultError("yol boş");
  if (segs.some((s) => s === "..")) throw new VaultError("yol üst dizine çıkamaz (..)");
  // Windows resolves `inbox.`, `logs ` (trailing dot/space), `inbox::$DATA` (stream) and `INBOX~1` (8.3 name) to the real entry:
  // none of them is a name this vault ever lists, so none is accepted as one.
  if (segs.some((s) => /[. ]$/.test(s) || s.includes(":") || /~[0-9]/.test(s))) throw new VaultError("yol geçersiz karakter içeriyor (sondaki nokta/boşluk, ':' veya '~n')");
  return segs;
}

function homeReal(): string {
  return realpathSync.native(getVladHome());
}

/** Real root the virtual "kb/" prefix maps to: the kb checkout (may live outside VLAD_HOME). */
function kbReal(): string {
  return realpathSync.native(kbPaths().kb);
}

/**
 * Real roots of one operation. `docs` is null when no docs folder exists. `docsInKb` is true when the kb is its own
 * repo and `<kb>/docs` is the docs root: then kb/docs is not part of the kb zone.
 */
interface Layout { home: string; kb: string; docs: string | null; docsInKb: boolean }

/** `<parent>/<segs>` as a docs root, only if it is a plain directory chain: no link anywhere on the way (fail closed). */
function plainDir(parent: string, segs: string[]): string | null {
  try {
    const lexical = join(parent, ...segs);
    const real = realpathSync.native(lexical);
    return real === lexical && statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function layout(): Layout {
  const home = homeReal();
  const kb = kbReal();
  if (isSeparateKb()) {
    const inKb = plainDir(kb, [KB_DOCS_DIR]);
    if (inKb) return { home, kb, docs: inKb, docsInKb: true };
  }
  return { home, kb, docs: plainDir(home, ["vault", "docs"]), docsInKb: false };
}

const within = (root: string, abs: string) => abs === root || abs.startsWith(root + sep);

/** Virtual path of a real path, or null when it is in neither root. The more specific docs root wins over the kb root. */
function virtualOf(l: Layout, abs: string): string[] | null {
  if (l.docs && within(l.docs, abs)) return ["vault", "docs", ...abs.slice(l.docs.length + 1).split(sep).filter(Boolean)];
  if (within(l.kb, abs)) return ["kb", ...abs.slice(l.kb.length + 1).split(sep).filter(Boolean)];
  return null;
}

/** Directory a virtual path hangs under, plus the real remainder. */
function locate(l: Layout, segs: string[]): string | null {
  if (denyKey(segs[0]) === "kb") return join(l.kb, ...segs.slice(1));
  return l.docs ? join(l.docs, ...segs.slice(2)) : null; // segs[0..1] is vault/docs (checked by allowedZone)
}

/** Resolves an allowlisted path to its real file. Throws VaultError on any violation. */
function resolveAllowed(input: string, want: "file" | "dir", l: Layout = layout()): { rel: string; abs: string } {
  const segs = parseUserPath(input);
  if (!allowedZone(segs, l.docsInKb)) throw new VaultError(`yol izin listesinde değil: ${segs.join("/")}`);
  const target = locate(l, segs);
  if (target === null) throw new VaultError(`bulunamadı: ${segs.join("/")}`);
  let abs: string;
  try {
    abs = realpathSync.native(target);
  } catch {
    throw new VaultError(`bulunamadı: ${segs.join("/")}`);
  }
  // A link may point from one zone into the other; the target is judged by the virtual path it lands on.
  const real = virtualOf(l, abs);
  if (real === null) {
    // inside VLAD_HOME but in neither root: judged (and refused) by the allowlist; anywhere else it left the root.
    // A stale <home>/kb next to a separate kb checkout is never readable through a link.
    const rel = within(l.home, abs) ? abs.slice(l.home.length + 1).split(sep) : null;
    if (rel && !(isSeparateKb() && denyKey(rel[0] ?? "") === "kb")) throw new VaultError(`yol izin listesinde değil: ${segs.join("/")}`);
    throw new VaultError("yol kök dışına çıkıyor");
  }
  if (!allowedZone(real, l.docsInKb)) throw new VaultError(`yol izin listesinde değil: ${segs.join("/")}`);
  const st = statSync(abs);
  if (want === "file" && !st.isFile()) throw new VaultError(`dosya değil: ${segs.join("/")}`);
  if (want === "dir" && !st.isDirectory()) throw new VaultError(`dizin değil: ${segs.join("/")}`);
  if (want === "file" && !/\.md$/i.test(abs)) throw new VaultError("yalnızca .md dosyaları okunur");
  return { rel: segs.join("/"), abs };
}

function readText(abs: string): string {
  // abs is already a realpath; O_NOFOLLOW + fstat close the swap-for-symlink window.
  const fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let buf: Buffer;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new VaultError("dosya değil");
    if (st.size > MAX_FILE_BYTES) throw new VaultError(`dosya çok büyük (${st.size} bayt > ${MAX_FILE_BYTES})`);
    buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let n = 0;
    for (let r = readSync(fd, buf, n, buf.length - n, null); r > 0; r = readSync(fd, buf, n, buf.length - n, null)) {
      n += r;
      if (n > MAX_FILE_BYTES) throw new VaultError(`dosya çok büyük (> ${MAX_FILE_BYTES} bayt)`);
    }
    buf = buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
  if (buf.includes(0)) throw new VaultError("ikili dosya okunamaz");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new VaultError("geçersiz UTF-8");
  }
}

/**
 * Drops a leading YAML front matter block (`---` ... `---`). Cards and task files keep local paths, worktrees and session ids
 * there; the API never shows them. An unterminated block is dropped to the end of the file (fail closed).
 */
export function stripFrontMatter(text: string): string {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = t.split("\n");
  if (lines[0].replace(/\r$/, "").trimEnd() !== "---") return text;
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l.replace(/\r$/, "")));
  return end < 0 ? "" : lines.slice(end + 1).join("\n");
}

export function parseHeadings(content: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  content.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m && m[2]) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  return out;
}

export function readVault(path: string, heading?: string, opts: { stripFrontMatter?: boolean } = {}): VaultFile {
  return safe(() => readVaultUnsafe(path, heading, opts));
}

function readVaultUnsafe(path: string, heading: string | undefined, opts: { stripFrontMatter?: boolean }): VaultFile {
  const { rel, abs } = resolveAllowed(path, "file");
  const raw = readText(abs);
  const full = opts.stripFrontMatter ? stripFrontMatter(raw) : raw;
  const headings = parseHeadings(full);
  if (heading === undefined) return { path: rel, content: full, headings };
  const want = fold(heading.trim());
  if (!want) throw new VaultError("başlık boş");
  const idx = headings.findIndex((h) => fold(h.text) === want);
  if (idx < 0) throw new VaultError(`başlık bulunamadı: ${heading}`);
  const start = headings[idx];
  const end = headings.slice(idx + 1).find((h) => h.level <= start.level);
  const lines = full.split("\n");
  const content = lines.slice(start.line - 1, end ? end.line - 1 : lines.length).join("\n").replace(/\s+$/, "");
  return { path: rel, content, headings };
}

export function listVault(dir?: string): { entries: VaultEntry[]; truncated: boolean } {
  return safe(() => {
    if (dir === undefined || dir === "") {
      return { entries: ZONES.map((z) => ({ path: ZONE_ROOT[z], type: "dir" as const })), truncated: false };
    }
    const l = layout();
    const { rel, abs } = resolveAllowed(dir, "dir", l);
    const entries: VaultEntry[] = [];
    let truncated = false;
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const e = entryFor(`${rel}/${d.name}`, d.name, l);
      if (!e) continue;
      if (entries.length >= MAX_LS_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push(e);
    }
    entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1));
    return { entries, truncated };
  });
}

/** An entry is shown only if it resolves (symlinks included) to an allowlisted .md file or dir. */
function entryFor(rel: string, name: string, l: Layout): VaultEntry | null {
  if (name.startsWith(".")) return null;
  for (const want of ["dir", "file"] as const) {
    try {
      const r = resolveAllowed(rel, want, l);
      if (want === "dir") return { path: r.rel, type: "dir" };
      return { path: r.rel, type: "file", size: statSync(r.abs).size };
    } catch {
      /* try the other kind */
    }
  }
  return null;
}

export function searchVault(
  query: string,
  opts: { zone?: string; limit?: number; budget?: Partial<SearchBudget>; stripFrontMatter?: boolean } = {},
): { hits: VaultHit[]; truncated: boolean } {
  return safe(() => searchUnsafe(query, opts));
}

function searchUnsafe(
  query: string,
  opts: { zone?: string; limit?: number; budget?: Partial<SearchBudget>; stripFrontMatter?: boolean },
): { hits: VaultHit[]; truncated: boolean } {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) throw new VaultError("sorgu boş");
  if (q.length > MAX_QUERY_CHARS) throw new VaultError(`sorgu çok uzun (en çok ${MAX_QUERY_CHARS} karakter)`);
  if (q.includes("\0")) throw new VaultError("sorgu null bayt içeremez");
  if (opts.zone !== undefined && !ZONES.includes(opts.zone as Zone)) throw new VaultError(`geçersiz bölge: ${opts.zone} (${ZONES.join(" | ")})`);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new VaultError(`limit 1..${MAX_LIMIT} olmalı`);
  const budget = { ...SEARCH_BUDGET, ...opts.budget };
  const started = Date.now();
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const needle = fold(q);
  const l = layout(); // a missing VLAD_HOME fails the whole search (generic "okunamadı"), not silently with no hits
  const zones = opts.zone ? [opts.zone as Zone] : ZONES;
  let hits: VaultHit[] = [];
  const rank = (a: VaultHit, b: VaultHit) => b.score - a.score || a.path.localeCompare(b.path);

  // Iterative walk: explicit stack, no recursion depth to blow.
  const stack: { rel: string; abs: string; depth: number }[] = [];
  for (const z of [...zones].reverse()) {
    const absRoot = z === "kb" ? l.kb : l.docs; // real roots: a linked root was already refused when the layout was built
    if (absRoot) stack.push({ rel: ZONE_ROOT[z], abs: absRoot, depth: 0 }); // zone missing: nothing to search
  }
  walk: while (stack.length) {
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (Date.now() - started > budget.ms || files >= budget.files || bytes >= budget.bytes) {
        truncated = true;
        break walk;
      }
      const rel = `${dir.rel}/${d.name}`;
      if (d.name.startsWith(".") || !allowedZone(rel.split("/"), l.docsInKb)) continue;
      if (d.isSymbolicLink()) continue; // search never follows links (no loops, no escapes)
      const abs = join(dir.abs, d.name);
      if (d.isDirectory()) {
        if (dir.depth + 1 > budget.depth) truncated = true;
        else stack.push({ rel, abs, depth: dir.depth + 1 });
        continue;
      }
      if (!d.isFile() || !/\.md$/i.test(d.name)) continue;
      files++;
      let text: string;
      try {
        bytes += statSync(abs).size;
        text = readText(abs);
      } catch {
        continue; // oversize, binary, invalid UTF-8 or unreadable: not searchable
      }
      const hit = scoreFile(rel, opts.stripFrontMatter ? stripFrontMatter(text) : text, needle);
      if (!hit) continue;
      hits.push(hit);
      if (hits.length > limit * 2) hits = hits.sort(rank).slice(0, limit);
    }
  }
  return { hits: hits.sort(rank).slice(0, limit), truncated };
}

function scoreFile(rel: string, text: string, needle: string): VaultHit | null {
  const lines = text.split("\n");
  const headingLines = new Set(parseHeadings(text).map((h) => h.line));
  let matches = 0;
  let score = 0;
  let first = 0;
  let snippet = "";
  lines.forEach((line, i) => {
    const n = occurrences(fold(line), needle);
    if (n === 0) return;
    matches += n;
    score += n + (headingLines.has(i + 1) ? 3 : 0);
    if (!first) {
      first = i + 1;
      snippet = line.trim().slice(0, 200);
    }
  });
  if (fold(rel).includes(needle)) score += 5;
  return score === 0 ? null : { path: rel, score, line: first, snippet, matches };
}

function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}
