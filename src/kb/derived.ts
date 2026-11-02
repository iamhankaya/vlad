import { fencedLines } from "./sections.js";

/** Marked blocks of a card that code regenerates (`vlad project refresh`); text outside them is never touched. Shared with the kb lint (phase A). */
export const DERIVED_CLOSE = "<!-- /vlad:derived -->";
export const derivedOpen = (name: string): string => `<!-- vlad:derived ${name} -->`;

const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

/** `open`, content, `close` as one LF-joined string (for `setSection`). */
export const wrapDerived = (name: string, content: string): string => `${derivedOpen(name)}\n${content}\n${DERIVED_CLOSE}`;

/**
 * Replaces the content of block `name`; a missing block is appended to the end of section `heading` (the section is created if missing).
 * Works on LF or CRLF text and keeps every byte outside the block.
 */
export function replaceDerivedBlock(text: string, name: string, content: string, heading: string): string {
  const eol = eolOf(text);
  const open = derivedOpen(name);
  const i = text.indexOf(open);
  if (i >= 0) {
    const j = text.indexOf(DERIVED_CLOSE, i);
    if (j < 0) throw new Error(`türetilen blok kapanmamış: ${name}`);
    return text.slice(0, i + open.length) + eol + content.split("\n").join(eol) + eol + text.slice(j);
  }
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
