#!/usr/bin/env node
// Lists test files that hand the developer's whole shell env to a child (`...process.env`, `env: process.env`) as JSON: [{file, line, text}].
// Allowed instead: isolatedEnv() from test/isolate-env.ts (drops user VLAD_*, case-insensitive) or test/support/spawn-vlad.ts. Same scan the ban test uses.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const PATTERN = /\.\.\.\s*process\.env\b|\benv\s*:\s*process\.env\b/;
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** @returns {{file: string, line: number, text: string}[]} */
export function findProcessEnvSpreads(base = root) {
  return walk(join(base, "test")).filter((f) => f.endsWith(".ts")).flatMap((f) =>
    readFileSync(f, "utf8").split("\n").flatMap((text, i) => (PATTERN.test(text) ? [{ file: relative(base, f).split("\\").join("/"), line: i + 1, text: text.trim() }] : [])));
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(JSON.stringify(findProcessEnvSpreads(), null, 2) + "\n");
