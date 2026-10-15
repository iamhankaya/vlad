/** Markdown section helpers. `heading` is the full heading line, e.g. "## Tanım". */

function range(lines: string[], heading: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
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
