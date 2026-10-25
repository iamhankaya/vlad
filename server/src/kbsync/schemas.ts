// The CLI's own JSON schemas (`schemas/*.schema.json`) as validators for the promote gate: a file is judged by the same rules the CLI judges it by.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (a: Ajv) => Ajv;
const cache = new Map<string, ValidateFunction>();

function schemasDir(): string {
  const beside = join(import.meta.dirname, "..", "..", "..", "schemas"); // <repo>/server/src/kbsync -> <repo>/schemas
  if (existsSync(join(beside, "project.schema.json"))) return beside;
  if (process.env.VLAD_HOME) return join(process.env.VLAD_HOME, "schemas");
  return beside;
}

/** `kind` of a schema file; returns the list of problems (empty = valid). Same Ajv options as `src/kb/schema.ts`. */
export function schemaProblems(kind: "project" | "active", data: unknown): string[] {
  const file = join(schemasDir(), `${kind}.schema.json`);
  let fn = cache.get(file);
  if (!fn) {
    fn = addFormats(new Ajv({ allErrors: true, strict: false })).compile(JSON.parse(readFileSync(file, "utf8")));
    cache.set(file, fn);
  }
  return fn(data) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`.trim());
}
