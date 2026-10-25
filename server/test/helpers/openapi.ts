import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parse } from "yaml";
import { CONTRACT_DIR } from "./contract.ts";

// CJS default exports: load through require so NodeNext typing does not see a namespace object
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");

export type Json = any;
export const HTTP_METHODS = ["get", "post", "put", "delete", "patch"] as const;
export const doc: Json = parse(readFileSync(join(CONTRACT_DIR, "openapi.yaml"), "utf8"));

export type Operation = { id: string; method: string; path: string; op: Json };
export const operations: Operation[] = Object.entries<Json>(doc.paths).flatMap(([path, item]) =>
  HTTP_METHODS.filter((m) => item[m]).map((m) => ({ id: item[m].operationId as string, method: m.toUpperCase(), path, op: item[m] })),
);

const make = (coerce: boolean) => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: coerce });
  addFormats(ajv);
  ajv.addSchema(doc, "openapi");
  return ajv;
};
const strictAjv = make(false);
const coerceAjv = make(true);

/** Resolves a one-level `$ref` into components (responses/parameters) used by operations. */
export function deref(node: Json): Json {
  if (node?.$ref?.startsWith("#/components/")) {
    const [, , group, name] = node.$ref.split("/");
    return doc.components[group][name];
  }
  return node;
}

export function validator(schema: Json, coerce = false): (v: unknown) => string[] {
  const ajv = coerce ? coerceAjv : strictAjv;
  const root = schema.$ref ? { $ref: `openapi${schema.$ref}` } : schema;
  const fn = ajv.compile(root);
  return (v) => (fn(v) ? [] : (fn.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath || "/"} ${e.message}`));
}

export const jsonSchema = (content: Json): Json | undefined => content?.content?.["application/json"]?.schema;
