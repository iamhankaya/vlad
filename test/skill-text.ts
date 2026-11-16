import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// T20261117-07: status/delegate/digest/integrate keep rarely needed sections in `reference/*.md` next to SKILL.md.
// Contract tests that assert a rule "lives in <skill>" read SKILL.md plus its reference files, so moving text does not change where a rule is defined.
const SPLIT = new Set(["status", "delegate", "digest", "integrate"]);

export function readText(file: string): string {
  const body = readFileSync(file, "utf8");
  if (basename(file) !== "SKILL.md" || !SPLIT.has(basename(dirname(file)))) return body;
  const refDir = join(dirname(file), "reference");
  if (!existsSync(refDir)) return body;
  const refs = readdirSync(refDir).filter((n) => n.endsWith(".md")).sort();
  return [body, ...refs.map((n) => readFileSync(join(refDir, n), "utf8"))].join("\n");
}

/** SKILL.md only (pointer lines, trigger conditions), without the reference files. */
export const readSkillOnly = (file: string): string => readFileSync(file, "utf8");
