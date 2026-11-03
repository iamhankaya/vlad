import { fencedLines } from "./sections.js";

/** Marked blocks of a card that code regenerates (`vlad project refresh`); text outside them is never touched. Shared with the kb lint (phase A). */
export const DERIVED_CLOSE = "<!-- /vlad:derived -->";
export const derivedOpen = (name: string): string => `<!-- vlad:derived ${name} -->`;

const OPEN_PREFIX = "<!-- vlad:derived ";
const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

/**
 * Locates block `name` outside code fences (a marker shown as an example in a fenced block is not a block).
 * `from` = end of the open marker, `close` = start of its close marker; null when there is no such block; throws when it is unclosed.
 */
function findBlock(text: string, name: string): { from: number; close: number } | null {
  const lines = text.split("\n");
  const plain = lines.map((l) => l.replace(/\r$/, ""));
  const fenced = fencedLines(plain);
  const open = derivedOpen(name);
  let off = 0;
  const starts = lines.map((l) => { const o = off; off += l.length + 1; return o; });
  const k = plain.findIndex((l, n) => !fenced[n] && l.trim() === open);
  if (k < 0) return null;
  for (let n = k + 1; n < lines.length; n++) {
    if (fenced[n]) continue;
    const t = plain[n].trim();
    if (t === DERIVED_CLOSE) return { from: starts[k] + plain[k].indexOf(open) + open.length, close: starts[n] + plain[n].indexOf(DERIVED_CLOSE) };
    if (t.startsWith(OPEN_PREFIX)) break; // a close that belongs to a later block must not be taken
  }
  throw new Error(`türetilen blok kapanmamış: ${name}`);
}

/** Content lines of block `name` (outside code fences); [] when there is none. */
export function derivedBlockLines(text: string, name: string): string[] {
  const b = findBlock(text, name);
  return b ? text.slice(b.from, b.close).split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim()) : [];
}

/** True when block `name` exists outside code fences. */
export const hasDerivedBlock = (text: string, name: string): boolean => findBlock(text, name) !== null;

/**
 * Replaces the content of block `name`; a missing block is appended to the end of section `heading` (the section is created if missing).
 * Works on LF or CRLF text and keeps every byte outside the block.
 */
export function replaceDerivedBlock(text: string, name: string, content: string, heading: string): string {
  const eol = eolOf(text);
  const open = derivedOpen(name);
  const b = findBlock(text, name);
  if (b) return text.slice(0, b.from) + eol + content.split("\n").join(eol) + eol + text.slice(b.close);
  const block = [open, ...content.split("\n"), DERIVED_CLOSE].map((l) => l + (eol === "\r\n" ? "\r" : ""));
  const lines = text.split("\n");
  const plain = lines.map((l) => l.replace(/\r$/, ""));
  const fenced = fencedLines(plain);
  const start = plain.findIndex((l, k) => !fenced[k] && l.trimEnd() === heading);
  if (start < 0) {
    const base = text.replace(/\s+$/, "");
    return `${base ? base + eol + eol : ""}${heading}${eol}${block.join("\n").replace(/\r$/, "")}${eol}`;
  }
  let end = lines.length;
  for (let k = start + 1; k < lines.length; k++) if (!fenced[k] && /^## /.test(plain[k])) { end = k; break; }
  let last = end - 1;
  while (last > start && !plain[last].trim()) last--;
  const gap = eol === "\r\n" ? "\r" : "";
  return [...lines.slice(0, last + 1), gap, ...block, ...lines.slice(last + 1)].join("\n");
}

/**
 * Like `replaceDerivedBlock`, but a missing block is put at the TOP of its section (one-time migration): hand-written lines stay below it byte for byte
 * (nothing outside a block is ever dropped). Once the block exists later calls only replace its content.
 */
export function setDerivedSection(text: string, name: string, content: string, heading: string): string {
  if (hasDerivedBlock(text, name)) return replaceDerivedBlock(text, name, content, heading);
  const lines = text.split("\n");
  const plain = lines.map((l) => l.replace(/\r$/, ""));
  const fenced = fencedLines(plain);
  const start = plain.findIndex((l, k) => !fenced[k] && l.trimEnd() === heading);
  if (start < 0) return replaceDerivedBlock(text, name, content, heading);
  const cr = eolOf(text) === "\r\n" ? "\r" : "";
  const block = [derivedOpen(name), ...content.split("\n"), DERIVED_CLOSE].map((l) => l + cr);
  const nextLine = plain[start + 1];
  const gap = nextLine !== undefined && nextLine.trim() && !/^## /.test(nextLine) ? [cr] : []; // blank line between the block and the hand-written lines below
  return [...lines.slice(0, start + 1), ...block, ...gap, ...lines.slice(start + 1)].join("\n");
}

/** True when the section heading (outside code fences) exists in `text`. */
export function hasSection(text: string, heading: string): boolean {
  const plain = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const fenced = fencedLines(plain);
  return plain.some((l, k) => !fenced[k] && l.trimEnd() === heading);
}

/** True for lines inside a derived block (marker lines included), so `kb lint` does not read generated text as a human claim. An unclosed block is not trusted: nothing is marked. */
export function derivedLines(lines: string[]): boolean[] {
  const marks = lines.map(() => false);
  let from = -1;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (from < 0) { if (t.startsWith(OPEN_PREFIX) && t.endsWith("-->")) from = i; } else if (t === DERIVED_CLOSE) { marks.fill(true, from, i + 1); from = -1; }
  });
  return marks;
}
