import type { WriteCmd } from "../machines/types.js";

/** Pure policy data for every CLI command (layer L1p: no handlers, no config reads). Design: T20261105-69 report, "Arayüzler". */
export type LockClass = "none" | "outer" | "phased"; // phased: with `machines` the handler locks inner regions, otherwise outer
export type ExecKind = "standard" | "status"; // status: the special branch (mark / 2 s lock fallback)
export type WorkerPolicy =
  | { kind: "local" }
  | { kind: "forward"; op: WriteCmd } // payload building stays in forward.ts
  | { kind: "reject" }; // fail-closed default
export type ConsolePolicy =
  | { kind: "read"; timeoutMs?: number; fileFlags?: string[] }
  | { kind: "write"; timeoutMs?: number; fileFlags?: string[] }
  | { kind: "none"; reason: string };

export interface CommandSpec {
  /** Commander path, e.g. ["digest","pending","add"]. */
  path: readonly string[];
  /** Only by hand when `legacyKey(path)` collides. */
  key?: string;
  /** "plain" = not registered through def() (e.g. `remote`). */
  registration: "def" | "plain";
  exec: ExecKind;
  lock: LockClass;
  /** Refreshes derived project-card blocks after the write; requires lock "outer". */
  refresh: boolean;
  worker: WorkerPolicy;
  console: ConsolePolicy;
  json: boolean;
}

/** The key `def()` used to derive: `<parent name> <first token of spec>`; top-level commands are `vlad <name>`. */
export const legacyKey = (p: readonly string[]): string => (p.length === 1 ? `vlad ${p[0]}` : `${p[p.length - 2]} ${p[p.length - 1]}`);

export const keyOf = (s: Pick<CommandSpec, "path" | "key">): string => s.key ?? legacyKey(s.path);

/**
 * Error list for a manifest; empty means valid. With `tree` (leaf command paths of the Commander program) it also
 * checks completeness both ways: every leaf is in the manifest and every manifest path is a leaf.
 */
export function validateManifest(specs: readonly CommandSpec[], tree?: readonly (readonly string[])[]): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const s of specs) {
    const name = s.path.join(" ");
    const key = keyOf(s);
    const prev = seen.get(key);
    if (prev !== undefined) errors.push(`anahtar çakışması "${key}": ${prev} / ${name} (key elle verilmeli)`);
    else seen.set(key, name);
    if (s.refresh && s.lock !== "outer") errors.push(`${name}: refresh için lock "outer" olmalı (şimdi "${s.lock}")`);
    if (s.console?.kind === "none" && !s.console.reason?.trim()) errors.push(`${name}: console none için reason zorunlu`);
    if (!s.worker) errors.push(`${name}: worker politikası eksik (fail-closed)`);
    if (s.exec === "status" && name !== "status") errors.push(`${name}: exec "status" yalnız \`vlad status\` için`);
  }
  if (tree) {
    const have = new Set(specs.map((s) => s.path.join(" ")));
    const leaves = new Set(tree.map((p) => p.join(" ")));
    for (const l of leaves) if (!have.has(l)) errors.push(`manifestte yok: ${l}`);
    for (const h of have) if (!leaves.has(h)) errors.push(`Commander ağacında yok: ${h}`);
  }
  return errors;
}
