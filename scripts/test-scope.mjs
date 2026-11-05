#!/usr/bin/env node
// Selective test run: changed files → buckets (test/scope.json). Never replaces the full suite (card gate / final gate stay `npm test`).
// Usage: node scripts/test-scope.mjs [--since <ref>] [--files a,b] [--json] [--run]
//   --since <ref>  changed = `git diff --name-only <ref>` + untracked (default HEAD: working tree changes)
//   --files        explicit list instead of git
//   --run          execute via scripts/test-run.mjs (unit --changed, selected buckets, changed test files by path)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectScope } from "./scope-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const since = val("--since") ?? "HEAD";
// the repo to diff and to read test/scope.json from is the caller's cwd repo (falls back to this checkout), so the map can be exercised on a scratch repo
const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
const repo = top.status === 0 ? top.stdout.trim() : root;
const git = (...a) => {
  const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) { process.stderr.write(`git ${a.join(" ")}: ${r.stderr}`); process.exit(1); }
  return r.stdout.split("\n").filter(Boolean);
};
const files = val("--files") !== undefined
  ? val("--files").split(",").filter(Boolean)
  : [...new Set([...git("diff", "--name-only", since), ...git("ls-files", "-o", "--exclude-standard")])];

const scope = JSON.parse(readFileSync(resolve(existsSync(resolve(repo, "test/scope.json")) ? repo : root, "test/scope.json"), "utf8"));
const buckets = JSON.parse(readFileSync(resolve(existsSync(resolve(repo, "test/buckets.json")) ? repo : root, "test/buckets.json"), "utf8"));
const sel = selectScope(files, scope, buckets);

if (argv.includes("--json")) process.stdout.write(JSON.stringify({ since, changed: files, ...sel, buckets: ["unit", ...sel.buckets] }) + "\n");
else {
  process.stderr.write(`değişen dosya: ${files.length}; unit: ${sel.unit === "all" ? "tamamı" : `--changed ${since}`}; kovalar: ${sel.buckets.join(",") || "-"}; dosyalar: ${sel.files.length}\n`);
  if (sel.unmapped.length) process.stderr.write(`eşlenmeyen yol (tüm kovalar koşar): ${sel.unmapped.join(", ")}\n`);
  for (const w of sel.warnings) process.stderr.write(`uyarı: ${w}\n`);
}

if (argv.includes("--run")) {
  const run = (args) => spawnSync(process.execPath, [resolve(root, "scripts/test-run.mjs"), ...args], { cwd: root, stdio: "inherit" }).status ?? 1;
  let code = 0;
  // every step runs even when an earlier one failed (one red unit test must not hide a red process bucket); a non-zero code is kept
  const step = (args) => { code = run(args) || code; };
  step(["--project", "unit", ...(sel.unit === "all" ? [] : ["--changed", since])]);
  if (sel.buckets.length) step(["--project", sel.buckets.join(",")]);
  if (sel.files.length) step(["--project", "process,agent,platform", "--", ...sel.files]);
  process.exit(code);
}
