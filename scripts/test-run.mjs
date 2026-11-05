#!/usr/bin/env node
// Fast test run: one `tsc`, then vitest projects one after another with VLAD_SKIP_BUILD=1 (global-setup still refuses a stale dist).
// Usage: node scripts/test-run.mjs [--project unit,process,...] [--changed <ref>] [-- <test file filters>]
// Without --project every bucket runs. `npm test` stays plain `vitest run` (card gate).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { matchGlob } from "./scope-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
const opts = dd < 0 ? argv : argv.slice(0, dd);
const filters = dd < 0 ? [] : argv.slice(dd + 1);
const val = (flag) => (opts.includes(flag) ? opts[opts.indexOf(flag) + 1] : undefined);
const all = Object.keys(JSON.parse(readFileSync(resolve(root, "test/buckets.json"), "utf8")));
const projects = (val("--project") ?? all.join(",")).split(",").filter(Boolean);
const changed = val("--changed");
const globs = Object.values(JSON.parse(readFileSync(resolve(root, "test/buckets.json"), "utf8"))).flat();
// --passWithNoTests below must not hide a test file that no bucket claims (it would silently never run)
const orphan = filters.filter((f) => !globs.some((g) => matchGlob(f, g)));
if (orphan.length) { process.stderr.write(`hiçbir kovada olmayan test dosyası: ${orphan.join(", ")} (test/buckets.json)\n`); process.exit(2); }
const bad = projects.filter((p) => !all.includes(p));
if (bad.length) { process.stderr.write(`bilinmeyen kova: ${bad.join(",")} (var: ${all.join(",")})\n`); process.exit(2); }

const sh = (cmd, args, env = {}) => spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
if (sh("npx", ["tsc"]).status !== 0) process.exit(1);

let code = 0;
for (const p of projects) {
  // --changed only narrows the unit bucket: process-style buckets spawn dist, so their tests are selected by bucket, not by module graph
  const args = ["vitest", "run", "--project", p, ...(changed && p === "unit" ? ["--passWithNoTests", "--changed", changed] : []), ...(filters.length ? ["--passWithNoTests"] : []), ...filters];
  const r = sh("npx", args, { VLAD_SKIP_BUILD: "1" });
  // exit 1 with "no tests found" must not hide a real failure, but --changed on an untouched unit bucket is not an error
  if (r.status !== 0) code = r.status ?? 1;
}
process.exit(code);
