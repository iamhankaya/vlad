import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const SRC = resolve(import.meta.dirname, "../../src");

export function walkTs(dir = SRC): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkTs(p) : p.endsWith(".ts") ? [p] : [];
  });
}

export interface Edge { from: string; to: string; spec: string; typeOnly: boolean }

/** Relative imports of a source file: static, `import()`, `require()`, re-exports. Type-only = `import type`, `export type`, or a braces list whose names are all `type X`. */
export function importsOf(file: string): Edge[] {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const edges: Edge[] = [];
  const add = (spec: string, typeOnly: boolean) => {
    if (!spec.startsWith(".")) return;
    edges.push({ from: relative(SRC, file), to: relative(SRC, resolve(dirname(file), spec)).replace(/\.js$/, ".ts"), spec, typeOnly });
  };
  for (const m of text.matchAll(/\b(?:import|export)\s+(type\s+)?([^;"'`]*?)\s*from\s*"([^"]+)"/g)) {
    const braces = /^\{([\s\S]*)\}$/.exec(m[2]!.trim())?.[1];
    const allType = braces !== undefined && braces.split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "));
    add(m[3]!, !!m[1] || allType);
  }
  for (const m of text.matchAll(/\bimport\s+"([^"]+)"/g)) add(m[1]!, false);
  for (const m of text.matchAll(/\b(?:import|require)\(\s*"([^"]+)"\s*\)/g)) add(m[1]!, false);
  return edges;
}

/** Top-level unit of a src-relative path: first directory, or the file itself at the top. */
export const unitOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : rel);
