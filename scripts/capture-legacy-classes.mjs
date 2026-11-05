#!/usr/bin/env node
// Dumps the hand-maintained command class sets (pre-U1 source of truth) from dist as JSON.
// Run against the pre-manifest build; the output is the equivalence baseline for test/commands/u1-*.test.ts.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const imp = (p) => import(pathToFileURL(resolve(root, "dist", p)).href);
const [{ KB_WRITES, REFRESH_KEYS }, fwd, cat, lock] = await Promise.all([imp("cli/program.js"), imp("agent/forward.js"), imp("agent/console-catalog.js"), imp("machines/lock-policy.js")]);
const sorted = (s) => [...s].sort();
process.stdout.write(JSON.stringify({
  KB_WRITES: sorted(KB_WRITES), REFRESH_KEYS: sorted(REFRESH_KEYS), WORKER_LOCAL: sorted(fwd.WORKER_LOCAL),
  FORWARD: Object.fromEntries(Object.entries(fwd.FORWARD).sort()), INNER_LOCK: sorted(lock.INNER_LOCK),
  CONSOLE_CATALOG: cat.CONSOLE_CATALOG,
}, null, 1) + "\n");
