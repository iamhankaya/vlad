// Pure rules of the promote gate (kb topology note K5): what may travel from `kb-server` to `vlad-kb` main. No git, no I/O.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

export const KB_ALLOWED_DIRS = ["projects", "tasks", "findings", "cards", "grants", "audit", "journal", "docs"] as const;
export const KB_ALLOWED_FILES = ["decisions.md", "active.md"] as const;
export const KB_DELETABLE = ["active.md"] as const;
/** `totalBytes` (all distinct blobs of one promote together) is an addition to the note: 2000 blobs of 1 MiB would otherwise be 2 GB for a main checkout. */
export const PROMOTE_LIMITS = { blobBytes: 1_048_576, changes: 2000, commits: 500, pathChars: 180, depth: 4, totalBytes: 64 * 1_048_576 } as const;

export type RuleId =
  | "path_not_allowed" | "dot_entry" | "bad_segment" | "windows_reserved" | "case_collision" | "path_too_long"
  | "bad_extension" | "symlink" | "submodule" | "mode" | "rename" | "delete_not_allowed" | "too_large" | "too_many_parents" | "sensitive_field";

export interface RawChange { status: "A" | "M" | "D" | "T" | "R" | "C" | "U" | "X"; oldMode: string; newMode: string; oldOid: string; newOid: string; path: string }
export interface Violation { rule: RuleId; path: string; detail?: string }

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;
const REGULAR = "100644";

/** `diff-tree -r -z --raw --no-renames` output: `:<omode> <nmode> <ooid> <noid> <status>\0<path>\0`. A rename/copy record carries two paths; the new one is kept. */
export function parseRawZ(out: string): RawChange[] {
  const parts = out.split("\0");
  const res: RawChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const head = parts[i]!;
    if (!head) { i++; continue; }
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])\d*$/.exec(head);
    if (!m) throw new Error(`diff-tree çıktısı anlaşılamadı: ${head.slice(0, 60)}`);
    const status = m[5] as RawChange["status"];
    const two = status === "R" || status === "C";
    const path = two ? parts[i + 2] : parts[i + 1];
    if (path === undefined) throw new Error("diff-tree çıktısı yarım");
    res.push({ status, oldMode: m[1]!, newMode: m[2]!, oldOid: m[3]!, newOid: m[4]!, path });
    i += two ? 3 : 2;
  }
  return res;
}

/** Path-only rules, in the table's order. The first match is reported. `case_collision` needs the whole tree (see {@link checkChanges}). */
export function checkPath(path: string): RuleId | null {
  const segs = path.split("/");
  const first = segs[0]!;
  const allowed = segs.length === 1 ? (KB_ALLOWED_FILES as readonly string[]).includes(first) : (KB_ALLOWED_DIRS as readonly string[]).includes(first);
  if (!allowed) return "path_not_allowed";
  if (segs.some((s) => s.startsWith("."))) return "dot_entry";
  for (const s of segs) if (s === "" || s === "." || s === ".." || /[. ]$/.test(s) || !SEGMENT.test(s)) return "bad_segment";
  if (segs.some((s) => RESERVED.test(s.split(".")[0]!))) return "windows_reserved";
  if (path.length > PROMOTE_LIMITS.pathChars || segs.length > PROMOTE_LIMITS.depth) return "path_too_long";
  if (!(/^audit\/[^/]+\.jsonl$/.test(path) || path.endsWith(".md"))) return "bad_extension";
  return null;
}

/** Paths among `changed` that collide, ignoring case, with another path or directory of `all` (Windows and macOS checkouts). */
function caseCollisions(changed: string[], all: string[]): Set<string> {
  const seen = new Map<string, Set<string>>();
  for (const p of all) {
    const segs = p.split("/");
    for (let i = 1; i <= segs.length; i++) {
      const prefix = segs.slice(0, i).join("/");
      const k = prefix.toLowerCase();
      (seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(prefix);
    }
  }
  const bad = new Set<string>();
  for (const p of changed) {
    const segs = p.split("/");
    for (let i = 1; i <= segs.length; i++) if ((seen.get(segs.slice(0, i).join("/").toLowerCase())?.size ?? 0) > 1) bad.add(p);
  }
  return bad;
}

/** Applies the K5 table to a list of raw changes; at most one (the first matching) violation per entry. */
export function checkChanges(ch: RawChange[], ctx: { sizeOf(oid: string): number; candidatePaths: string[] }): Violation[] {
  if (ch.length > PROMOTE_LIMITS.changes) return [{ rule: "too_large", path: "(changes)", detail: `${ch.length} > ${PROMOTE_LIMITS.changes}` }];
  const out: Violation[] = [];
  const live = ch.filter((c) => c.status !== "D").map((c) => c.path);
  const collide = caseCollisions(live, [...new Set([...ctx.candidatePaths, ...live])]);
  for (const c of ch) {
    const rule = rowRule(c, collide, ctx.sizeOf);
    if (rule) out.push({ rule, path: c.path });
  }
  return out;
}

function rowRule(c: RawChange, collide: Set<string>, sizeOf: (oid: string) => number): RuleId | null {
  const pathRule = checkPath(c.path);
  // the table's order: path_not_allowed, dot_entry, bad_segment, windows_reserved come before case_collision, which comes before the length/extension rules
  if (pathRule === "path_not_allowed" || pathRule === "dot_entry" || pathRule === "bad_segment" || pathRule === "windows_reserved") return pathRule;
  if (c.status !== "D" && collide.has(c.path)) return "case_collision";
  if (pathRule) return pathRule;
  if (c.status === "D") return (KB_DELETABLE as readonly string[]).includes(c.path) ? null : "delete_not_allowed";
  if (c.newMode === "120000") return "symlink";
  if (c.newMode === "160000") return "submodule";
  if (c.newMode !== REGULAR) return "mode";
  if (c.status === "R" || c.status === "C") return "rename";
  if (c.status === "U" || c.status === "X") return "mode";
  if (sizeOf(c.newOid) > PROMOTE_LIMITS.blobBytes) return "too_large";
  return null;
}

/** The `---` frontmatter of a kb markdown file as an object; null when there is none or it does not parse. */
function frontmatter(text: string): Record<string, unknown> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  try {
    const v: unknown = YAML.parse(m[1]!);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const EXEC_FIELDS = ["gate", "repo", "default_branch", "path", "local_only"] as const;
/** Fields that make a command run or point work at another clone, even on a brand-new card. */
const BORN_FIELDS = ["gate", "local_only"] as const;

/**
 * K5 `sensitive_field`: a server-side change to what a project card makes VLAD run or open (`gate`, `repo`, `default_branch`,
 * `path`, `local_only`, another machine's `paths` entry). The body and the server's own `paths` entry stay free. A new card
 * (`oldText` null) may not carry a `gate` or `local_only`. Call for `projects/<slug>.md` only.
 */
export function checkSensitiveFields(path: string, oldText: string | null, newText: string | null, serverMachine: string): Violation[] {
  if (newText === null) return [];
  const next = frontmatter(newText);
  if (!next) return [{ rule: "sensitive_field", path, detail: "frontmatter" }];
  const out: Violation[] = [];
  const hit = (detail: string) => out.push({ rule: "sensitive_field", path, detail });
  if (oldText === null) {
    for (const f of BORN_FIELDS) if (f in next) hit(f);
    return out;
  }
  const prev = frontmatter(oldText) ?? {};
  for (const f of EXEC_FIELDS) if (!isDeepStrictEqual(prev[f], next[f])) hit(f);
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const a = obj(prev.paths), b = obj(next.paths);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k !== serverMachine && !isDeepStrictEqual(a[k], b[k])) hit(`paths.${k}`);
  }
  return out;
}

/** Dedupe key of a kb_conflict (K6): the same set of lines always gives the same key. Same formula as `src/kb/sync.ts`. */
export function conflictKey(reason: "merge_conflict" | "rejected", lines: string[]): string {
  return createHash("sha256").update(`vlad-kbconflict/v1\n${reason}\n${[...lines].sort().join("\n")}`).digest("hex");
}
