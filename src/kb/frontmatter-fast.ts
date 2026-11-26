/**
 * Fast path for the frontmatter shapes the kb writes (T20261126-25: `yaml` parsing was ~200 ms of every listing):
 * a flat map of `key: scalar` lines, `key:` + `- item` block lists, single-line plain/quoted scalars and the
 * serializer's folded multi-line double-quoted strings. Anything outside that narrow grammar returns `undefined`
 * and the caller parses with `yaml` (core schema), so the result is either identical or not produced at all.
 */

const FAIL = Symbol("fail");
type Scalar = string | number | boolean | null | never[];

const KEY_LINE = /^([a-z_][a-z0-9_]*):(?: (.*))?$/;
const ITEM_LINE = /^( *)- (.*)$/;
/** Characters `yaml` may treat specially (controls, NEL/C1, line/paragraph separators, BOM, lone surrogates): leave them to it. */
const ODD_CHARS = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029\ufeff]|[\ud800-\udfff]/u;
/** Plain scalars the core schema resolves to something other than a string (or that need a closer look). */
const CORE_SPECIAL = [
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE)$/,
  /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/,
  /^[-+]?\.(?:inf|Inf|INF)$/,
  /^\.(?:nan|NaN|NAN)$/,
  /^0o[0-7]+$/,
  /^0x[0-9a-fA-F]+$/,
];
const PLAIN_FIRST_BAD = new Set([..."-?:,[]{}#&*!|>'\"%@` \t"]);
/** YAML white space is space and tab only (`trimEnd` would also eat U+00A0 etc.). */
const trimWsEnd = (s: string): string => s.replace(/[ \t]+$/, "");
const trimWsStart = (s: string): string => s.replace(/^[ \t]+/, "");

function scalar(v: string): Scalar | typeof FAIL {
  if (v === "" || ODD_CHARS.test(v)) return FAIL;
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "[]") return [];
  if (/^(?:0|[1-9][0-9]{0,14})$/.test(v)) return Number(v);
  const c = v[0];
  if (c === '"') { const m = /^"([^"\\]*)"$/.exec(v); return m ? m[1] : FAIL; }
  if (c === "'") { const m = /^'([^']*)'$/.exec(v); return m ? m[1] : FAIL; }
  if (!plainSafe(v)) return FAIL;
  return v;
}

/** A plain-scalar piece with no indicator, comment, tab or core-schema meaning. */
function plainSafe(v: string): boolean {
  if (v === "" || PLAIN_FIRST_BAD.has(v[0]) || ODD_CHARS.test(v)) return false;
  if (v.includes(": ") || v.includes(" #") || v.includes("\t") || v.endsWith(":") || v.endsWith(" ")) return false;
  return !CORE_SPECIAL.some((re) => re.test(v));
}

/** Indented lines after a plain scalar: folded into it with single spaces (`yaml` multi-line plain), or FAIL. */
function foldPlain(first: string, lines: string[], i: number): { value: string; next: number } | typeof FAIL {
  const parts = [first];
  while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
    if (!/^ +[^ \t]/.test(lines[i + 1])) return FAIL; // tab indentation is a `yaml` error
    const piece = trimWsEnd(trimWsStart(lines[i + 1]));
    if (!plainSafe(piece)) return FAIL; // blank line (a kept newline), comment, nested key, list item…
    parts.push(piece);
    i++;
  }
  const value = parts.join(" ");
  return plainSafe(value) ? { value, next: i } : FAIL;
}

/** `key:` + indented `k: scalar` lines (one level, same indent, single-line scalars): `experiment:\n  ponytail: off`. */
function nestedMap(lines: string[], i: number): { value: Record<string, Scalar>; next: number } | typeof FAIL {
  const out: Record<string, Scalar> = {};
  let indent: string | undefined;
  while (i + 1 < lines.length && /^ /.test(lines[i + 1])) {
    const m = /^( +)([a-z_][a-z0-9_]*):(?: (.*))?$/.exec(lines[i + 1]);
    if (!m || m[3] === undefined || (indent !== undefined && m[1] !== indent)) return FAIL;
    indent = m[1];
    if (m[2] === "__proto__" || Object.prototype.hasOwnProperty.call(out, m[2])) return FAIL;
    const v = scalar(m[3]);
    if (v === FAIL) return FAIL;
    out[m[2]] = v;
    i++;
  }
  return { value: out, next: i };
}

export function fastFrontmatter(src: string): Record<string, unknown> | undefined {
  if (!src) return undefined;
  const lines = src.split("\n");
  const out: Record<string, unknown> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = KEY_LINE.exec(lines[i]);
    if (!m) return undefined;
    const key = m[1];
    if (key === "__proto__" || Object.prototype.hasOwnProperty.call(out, key)) return undefined;
    const raw = m[2];
    if (raw === undefined && i + 1 < lines.length && /^ +[a-z_][a-z0-9_]*:/.test(lines[i + 1])) {
      const map = nestedMap(lines, i);
      if (map === FAIL) return undefined;
      if (map.next + 1 < lines.length && /^[ \t-]/.test(lines[map.next + 1])) return undefined;
      out[key] = map.value;
      i = map.next;
      continue;
    }
    if (raw === undefined) {
      // `key:` alone: a block list of single-line scalars, or null
      const items: Scalar[] = [];
      let indent: string | undefined;
      while (i + 1 < lines.length) {
        const it = ITEM_LINE.exec(lines[i + 1]);
        if (!it) break;
        if (indent !== undefined && it[1] !== indent) return undefined;
        indent = it[1];
        const v = scalar(it[2]);
        if (v === FAIL || Array.isArray(v)) return undefined;
        items.push(v);
        i++;
      }
      if (i + 1 < lines.length && /^[ \t-]/.test(lines[i + 1])) return undefined; // nested map, continuation, odd list
      out[key] = items.length ? items : null;
      continue;
    }
    const v = scalar(raw);
    if (v !== FAIL) {
      if (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
        // only a plain string folds over lines; quoted/null/number/[] followed by indented text is left to `yaml`
        if (typeof v !== "string" || v !== raw || raw[0] === '"' || raw[0] === "'") return undefined;
        const folded = foldPlain(v, lines, i);
        if (folded === FAIL) return undefined;
        out[key] = folded.value;
        i = folded.next;
        continue;
      }
      out[key] = v;
      continue;
    }
    // the serializer's folded double-quoted string: "first\n  middle\n  last"
    if (raw[0] !== '"' || raw.length < 2 || raw.includes("\\") || raw.indexOf('"', 1) !== -1 || ODD_CHARS.test(raw)) return undefined;
    const first = trimWsEnd(raw.slice(1));
    if (!first) return undefined;
    const parts = [first];
    let closed = false;
    while (!closed) {
      i++;
      if (i >= lines.length) return undefined;
      const line = lines[i];
      if (!/^ +[^ \t]/.test(line) || line.includes("\\") || ODD_CHARS.test(line)) return undefined; // space-indented only (tabs: left to `yaml`)
      const q = line.indexOf('"');
      if (q !== -1 && q !== line.length - 1) return undefined;
      let piece = trimWsStart(line);
      if (q === -1) piece = trimWsEnd(piece);
      else { piece = piece.slice(0, -1); closed = true; }
      if (!piece) return undefined; // blank line (a kept newline) or empty closing line
      parts.push(piece);
    }
    out[key] = parts.join(" ");
  }
  return out;
}
