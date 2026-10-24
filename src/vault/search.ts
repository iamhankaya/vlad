import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { getVladHome } from "../kb/index.js";

/**
 * Read-only vault access. Allowlist (paths are relative to VLAD_HOME, "/"-separated):
 *   kb/        except kb/inbox, kb/logs, kb/grants, kb/audit and any dot-entry
 *   vault/docs/
 * Only *.md files are readable. Every path (input and symlink target) is checked after
 * lower-casing, so case variants cannot reach a forbidden folder.
 */

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_QUERY_CHARS = 256;
export const MAX_PATH_CHARS = 512;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export type Zone = "kb" | "docs";
export const ZONES: Zone[] = ["kb", "docs"];
const ZONE_ROOT: Record<Zone, string> = { kb: "kb", docs: "vault/docs" };
const FORBIDDEN_UNDER_KB = ["inbox", "logs", "grants", "audit"];

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
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
function allowedZone(rel: string[]): Zone | null {
  const low = rel.map((s) => s.toLowerCase());
  if (low.some((s) => s.startsWith("."))) return null;
  if (low[0] === "kb") {
    if (low.length > 1 && FORBIDDEN_UNDER_KB.includes(low[1])) return null;
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
  return segs;
}

function homeReal(): string {
  return realpathSync(getVladHome());
}

/** Resolves an allowlisted path to its real file. Throws VaultError on any violation. */
function resolveAllowed(input: string, want: "file" | "dir"): { rel: string; abs: string } {
  const segs = parseUserPath(input);
  if (!allowedZone(segs)) throw new VaultError(`yol izin listesinde değil: ${segs.join("/")}`);
  const home = homeReal();
  let abs: string;
  try {
    abs = realpathSync(join(home, ...segs));
  } catch {
    throw new VaultError(`bulunamadı: ${segs.join("/")}`);
  }
  if (abs !== home && !abs.startsWith(home + sep)) throw new VaultError("yol kök dışına çıkıyor");
  const realRel = abs.slice(home.length + 1).split(sep);
  if (!allowedZone(realRel)) throw new VaultError(`yol izin listesinde değil: ${segs.join("/")}`);
  const st = statSync(abs);
  if (want === "file" && !st.isFile()) throw new VaultError(`dosya değil: ${segs.join("/")}`);
  if (want === "dir" && !st.isDirectory()) throw new VaultError(`dizin değil: ${segs.join("/")}`);
  if (want === "file" && !/\.md$/i.test(abs)) throw new VaultError("yalnızca .md dosyaları okunur");
  return { rel: segs.join("/"), abs };
}

function readText(abs: string): string {
  const st = statSync(abs);
  if (st.size > MAX_FILE_BYTES) throw new VaultError(`dosya çok büyük (${st.size} bayt > ${MAX_FILE_BYTES})`);
  const buf = readFileSync(abs);
  if (buf.includes(0)) throw new VaultError("ikili dosya okunamaz");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new VaultError("geçersiz UTF-8");
  }
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

export function readVault(path: string, heading?: string): VaultFile {
  const { rel, abs } = resolveAllowed(path, "file");
  const full = readText(abs);
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

export function listVault(dir?: string): VaultEntry[] {
  if (dir === undefined || dir === "") {
    return ZONES.map((z) => ({ path: ZONE_ROOT[z], type: "dir" as const }));
  }
  const { rel, abs } = resolveAllowed(dir, "dir");
  const entries: VaultEntry[] = [];
  for (const d of readdirSync(abs, { withFileTypes: true })) {
    const childRel = `${rel}/${d.name}`;
    const e = entryFor(childRel, d.name);
    if (e) entries.push(e);
  }
  return entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1));
}

/** An entry is shown only if it resolves (symlinks included) to an allowlisted .md file or dir. */
function entryFor(rel: string, name: string): VaultEntry | null {
  if (name.startsWith(".")) return null;
  for (const want of ["dir", "file"] as const) {
    try {
      const r = resolveAllowed(rel, want);
      if (want === "dir") return { path: r.rel, type: "dir" };
      return { path: r.rel, type: "file", size: statSync(r.abs).size };
    } catch {
      /* try the other kind */
    }
  }
  return null;
}

function* walk(relDir: string, absDir: string): Generator<{ rel: string; abs: string }> {
  for (const d of readdirSync(absDir, { withFileTypes: true })) {
    const rel = `${relDir}/${d.name}`;
    if (d.name.startsWith(".") || !allowedZone(rel.split("/"))) continue;
    const abs = join(absDir, d.name);
    if (d.isSymbolicLink()) continue; // search never follows links (no loops, no escapes)
    if (d.isDirectory()) yield* walk(rel, abs);
    else if (d.isFile() && /\.md$/i.test(d.name)) yield { rel, abs };
  }
}

export function searchVault(query: string, opts: { zone?: string; limit?: number } = {}): VaultHit[] {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) throw new VaultError("sorgu boş");
  if (q.length > MAX_QUERY_CHARS) throw new VaultError(`sorgu çok uzun (en çok ${MAX_QUERY_CHARS} karakter)`);
  if (q.includes("\0")) throw new VaultError("sorgu null bayt içeremez");
  if (opts.zone !== undefined && !ZONES.includes(opts.zone as Zone)) throw new VaultError(`geçersiz bölge: ${opts.zone} (${ZONES.join(" | ")})`);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new VaultError(`limit 1..${MAX_LIMIT} olmalı`);
  const needle = fold(q);
  const home = homeReal();
  const zones = opts.zone ? [opts.zone as Zone] : ZONES;
  const hits: VaultHit[] = [];
  for (const z of zones) {
    const root = ZONE_ROOT[z];
    let absRoot: string;
    try {
      absRoot = join(home, ...root.split("/"));
      if (lstatSync(absRoot).isSymbolicLink()) absRoot = resolveAllowed(root, "dir").abs;
    } catch {
      continue;
    }
    for (const f of walk(root, absRoot)) {
      let text: string;
      try {
        text = readText(f.abs);
      } catch {
        continue; // oversize, binary or invalid UTF-8: not searchable
      }
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
      if (fold(f.rel).includes(needle)) score += 5;
      if (score === 0) continue;
      hits.push({ path: f.rel, score, line: first, snippet, matches });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, limit);
}

function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}
