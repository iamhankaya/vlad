/** Markdown section helpers. `heading` is the full heading line, e.g. "## Tanım". */

/** True for lines inside a code fence (fence lines included). An unclosed fence is not trusted: nothing is marked, so a stray ``` cannot hide later headings (F-vlad-075). */
function fencedLines(lines: string[]): boolean[] {
  const marks = lines.map(() => false);
  let open: { ch: string; len: number } | null = null;
  let from = 0;
  lines.forEach((l, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (!open) {
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) { open = { ch: m[1][0], len: m[1].length }; from = i; }
    } else if (m && m[1][0] === open.ch && m[1].length >= open.len && !m[2].trim()) {
      marks.fill(true, from, i + 1);
      open = null;
    }
  });
  return marks;
}

function range(lines: string[], heading: string): { start: number; end: number } | null {
  const fenced = fencedLines(lines);
  const start = lines.findIndex((l, i) => !fenced[i] && l.trimEnd() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!fenced[i] && /^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

export function getSection(body: string, heading: string): string | null {
  const lines = body.split("\n");
  const r = range(lines, heading);
  if (!r) return null;
  return lines.slice(r.start + 1, r.end).join("\n").trim();
}

export function setSection(body: string, heading: string, text: string): string {
  const lines = body.split("\n");
  const r = range(lines, heading);
  const content = text.replace(/\s+$/, "");
  if (!r) {
    const base = body.replace(/\s+$/, "");
    return `${base ? base + "\n\n" : ""}${heading}\n${content}\n`;
  }
  const out = [
    ...lines.slice(0, r.start),
    heading,
    ...content.split("\n"),
    ...(r.end < lines.length ? [""] : []),
    ...lines.slice(r.end),
  ].join("\n");
  return out.endsWith("\n") ? out : out + "\n";
}

export function appendToSection(body: string, heading: string, line: string): string {
  const cur = getSection(body, heading);
  return setSection(body, heading, cur ? `${cur}\n${line}` : line);
}
