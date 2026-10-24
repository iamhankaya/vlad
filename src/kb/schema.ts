import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { kbPaths } from "./home.js";

const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (a: Ajv) => Ajv;

export type SchemaKind = "project" | "task" | "inbox" | "config" | "role" | "finding" | "card";

export class ValidationError extends Error {
  constructor(public details: string[]) {
    super(`doğrulama hatası: ${details.join("; ")}`);
    this.name = "ValidationError";
  }
}

const cache = new Map<string, ValidateFunction>();

function compiled(kind: SchemaKind, home?: string): ValidateFunction {
  const file = join(kbPaths(home).schemas, `${kind}.schema.json`);
  let fn = cache.get(file);
  if (!fn) {
    const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
    fn = ajv.compile(JSON.parse(readFileSync(file, "utf8")));
    cache.set(file, fn);
  }
  return fn;
}

/** `home` (optional) selects the VLAD home whose schemas/ is used; default follows getVladHome(). */
export function validate(kind: SchemaKind, data: unknown, home?: string): void {
  const fn = compiled(kind, home);
  if (!fn(data)) {
    throw new ValidationError(
      (fn.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`.trim()),
    );
  }
}
