import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { safeWriteFile } from "./safefs.js";

const FRONT = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/;

/** Parse "---\nyaml\n---\n\nbody". CRLF tolerated. Dates stay strings (core schema). */
export function parseDoc<T>(text: string): { data: T; body: string } {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = FRONT.exec(src);
  if (!m) throw new Error("frontmatter yok");
  const data = (parse(m[1] ?? "", { schema: "core" }) ?? {}) as T;
  const body = src.slice(m[0].length).replace(/^\n/, "");
  return { data, body };
}

export function serializeDoc(data: object, body: string): string {
  return `---\n${stringify(data, { schema: "core" })}---\n\n${body}`;
}

export function readDoc<T>(file: string): { data: T; body: string } {
  return parseDoc<T>(readFileSync(file, "utf8"));
}

export function writeDoc(file: string, data: object, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  safeWriteFile(file, serializeDoc(data, body));
}
