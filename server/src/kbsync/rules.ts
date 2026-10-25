// Pure rules of the promote gate (kb topology note K5): what may travel from `kb-server` to `vlad-kb` main. No git, no I/O.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

export const KB_ALLOWED_DIRS = ["projects", "tasks", "findings", "cards", "grants", "audit", "journal", "docs"] as const;
export const KB_ALLOWED_FILES = ["decisions.md", "active.md"] as const;
/** Nothing may be deleted. (`active.md` used to be deletable; its content rules now cover it, and a release is the user's act on Windows.) */
export const KB_DELETABLE = [] as const;
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

/** Same front-matter pattern, BOM and CRLF handling as the CLI's `parseDoc` (`src/kb/doc.ts`). */
const FRONT = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/;

/**
 * The front matter exactly as the CLI reads it (core schema), but stricter: anything the CLI's parser could read differently from a
 * plain reading is refused: `%` directives (a `%YAML 1.1` line switches the schema), anchors and aliases, explicit tags, `<<` merge keys,
 * several documents or any parser error/warning (security review, finding 2). Null when there is none or it is refused.
 */
export function strictFrontmatter(text: string): Record<string, unknown> | null {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = FRONT.exec(src);
  if (!m) return null;
  const yaml = m[1] ?? "";
  if (/^%/m.test(yaml) || /^(---|\.\.\.)[ \t]*$/m.test(yaml)) return null;
  try {
    const doc = YAML.parseDocument(yaml, { schema: "core", uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length || doc.directives.docStart || doc.directives.yaml.explicit) return null;
    let refused = false;
    YAML.visit(doc, {
      Alias: () => { refused = true; },
      Node: (_k, node) => { if (node.anchor || node.tag) refused = true; },
      Pair: (_k, pair) => { if (YAML.isScalar(pair.key) && pair.key.value === "<<") refused = true; },
    });
    if (refused) return null;
    const v: unknown = doc.toJS();
    if (v === null || v === undefined) return {};
    return typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const EXEC_FIELDS = ["slug", "gate", "repo", "default_branch", "path", "local_only"] as const;

/** `owner/name` of a GitHub repository however it is written (URL, ssh form, `.git`, case); anything else comes back lower-cased as it was. */
export function normalizeRepo(v: unknown): string {
  let s = String(v ?? "").trim().toLowerCase();
  s = s.replace(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[/:]/, "").replace(/[/]+$/, "").replace(/\.git$/, "");
  return s;
}

export interface SensitiveContext {
  /** Problems of the new front matter against the CLI's schema (`schemaProblems`); empty = valid. Omitted: not checked. */
  validate?: (data: unknown) => string[];
  /** Normalized `repo` of every project card main already has, and the kb repository itself: a new card may not claim one of them. */
  takenRepos?: ReadonlySet<string>;
}

/**
 * K5 `sensitive_field`: a server-side change to what a project card makes VLAD run or open (`gate`, `repo`, `default_branch`,
 * `path`, `local_only`, `slug`, another machine's `paths` entry; `slug` must also equal the file name). The body and the server's own `paths` entry stay free. A NEW card
 * (`oldText` null) is stricter (finding 4): only the server's own `paths` entry; `path` must equal it; no `gate`, `local_only`
 * or other machine's `paths`; `repo` may not be the kb repository or one an existing card already has. Call for `projects/<slug>.md` only.
 */
export function checkSensitiveFields(path: string, oldText: string | null, newText: string | null, serverMachine: string, ctx: SensitiveContext = {}): Violation[] {
  if (newText === null) return [];
  const next = strictFrontmatter(newText);
  if (!next) return [{ rule: "sensitive_field", path, detail: "frontmatter" }];
  const out: Violation[] = [];
  const hit = (detail: string) => out.push({ rule: "sensitive_field", path, detail });
  const problems = ctx.validate?.(next) ?? [];
  if (problems.length) hit(`schema: ${problems[0]}`);
  // `projects/<slug>.md` is the card of project `<slug>`: a card whose slug is another name would shadow that project (review Y1)
  if (next.slug !== path.replace(/^projects\//, "").replace(/\.md$/, "")) hit("slug");
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const b = obj(next.paths);
  if (oldText === null) {
    for (const f of ["gate", "local_only"]) if (f in next) hit(f);
    for (const k of Object.keys(b)) if (k !== serverMachine) hit(`paths.${k}`);
    if (typeof next.path === "string" && next.path !== b[serverMachine]) hit("path");
    if ("repo" in next && ctx.takenRepos?.has(normalizeRepo(next.repo))) hit("repo");
    return out;
  }
  const prev = strictFrontmatter(oldText) ?? {};
  for (const f of EXEC_FIELDS) if (!isDeepStrictEqual(prev[f], next[f])) hit(f);
  const a = obj(prev.paths);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k !== serverMachine && !isDeepStrictEqual(a[k], b[k])) hit(`paths.${k}`);
  }
  return out;
}

export interface ActiveContext {
  serverMachine: string;
  /** state.json: a takeover is pending and started recently (the server's own record, not the agent's). */
  takeoverPending: boolean;
  validate?: (data: unknown) => string[];
}

/**
 * `active.md` may change on main in two cases only (finding 3): (a) a recent takeover of this server is pending and the new record names this
 * server; (b) main already names this server and only the heartbeat moves forward. Everything else, a deletion included, is refused.
 */
export function checkActiveChange(path: string, oldText: string | null, newText: string | null, ctx: ActiveContext): Violation[] {
  const no = (detail: string): Violation[] => [{ rule: "sensitive_field", path, detail: `active.md: ${detail}` }];
  if (newText === null) return no("silinemez");
  const next = strictFrontmatter(newText);
  if (!next) return no("frontmatter");
  const problems = ctx.validate?.(next) ?? [];
  if (problems.length) return no(`schema: ${problems[0]}`);
  if (next.machine !== ctx.serverMachine) return no("başka makineyi etkin yapamaz");
  if (ctx.takeoverPending) return [];
  const prev = oldText === null ? null : strictFrontmatter(oldText);
  if (prev && prev.machine === ctx.serverMachine && prev.since === next.since && isDeepStrictEqual(prev.takeover_from, next.takeover_from) && Date.parse(String(next.heartbeat)) >= Date.parse(String(prev.heartbeat))) return [];
  return no("devralma beklemiyor");
}

/** Dedupe key of a kb_conflict (K6): the same set of lines always gives the same key. Same formula as `src/kb/sync.ts`. */
export function conflictKey(reason: "merge_conflict" | "rejected", lines: string[]): string {
  return createHash("sha256").update(`vlad-kbconflict/v1\n${reason}\n${[...lines].sort().join("\n")}`).digest("hex");
}
