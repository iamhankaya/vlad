import { constants, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { parse, stringify } from "yaml";

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

/** Reads a kb file as text, refusing a symlink: writes refuse links already; reads must not leave the kb either (F-vlad-036). O_NOFOLLOW (POSIX) closes the lstat→read window; Windows keeps the lstat check. */
export function readText(file: string): string {
  if (lstatSync(file).isSymbolicLink()) throw new Error(`symlink okunmaz: ${file}`);
  return readFileSync(file, { encoding: "utf8", flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) });
}

export function readDoc<T>(file: string): { data: T; body: string } {
  return parseDoc<T>(readText(file));
}

export function writeDoc(file: string, data: object, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, serializeDoc(data, body));
}
