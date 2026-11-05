import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Marker words are assembled so this helper does not match its own scan (it is imported by unit-bucket tests).
const CP = ["child", "process"].join("_");
const DIST = ["di", "st"].join("");
const HELPER = ["spawn", "vlad"].join("-");
const SPAWN_OR_DIST = new RegExp(`${CP}|["'/\\\\]${DIST}["'/\\\\]|${HELPER}`);

/** True when source text spawns processes or touches the built CLI (the `process` bucket's defining traits). */
export const usesSpawnOrDist = (src: string): boolean => SPAWN_OR_DIST.test(src);

/** Glob subset used by test/buckets.json: `**` crosses directories, `*` stays within a segment. */
export function matchGlob(path: string, glob: string): boolean {
  const re = glob
    .split("**/")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join("(?:.*/)?");
  return new RegExp(`^${re}$`).test(path);
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** Repo-relative (posix) paths of every `test/**\/*.test.ts` file. */
export function listTestFiles(root: string): string[] {
  return walk(join(root, "test"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => relative(root, f).split("\\").join("/"))
    .sort();
}

/** The file plus every relative import it reaches inside test/ (repo-relative posix paths). */
export function importClosure(root: string, file: string): Set<string> {
  const seen = new Set<string>([file]);
  const stack = [file];
  while (stack.length) {
    const cur = stack.pop() as string;
    const src = readFileSync(join(root, cur), "utf8");
    for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const abs = resolve(dirname(join(root, cur)), m[1].replace(/\.js$/, ".ts"));
      const rel = relative(root, abs).split("\\").join("/");
      if (rel.startsWith("test/") && existsSync(abs) && !seen.has(rel)) {
        seen.add(rel);
        stack.push(rel);
      }
    }
  }
  return seen;
}
