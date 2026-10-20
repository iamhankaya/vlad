import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** Builds dist/ once for all test files (parallel per-file `tsc` runs raced on the shared dist/). */
export default function setup(): void {
  const r = spawnSync("npx", ["tsc"], { cwd: resolve(import.meta.dirname, ".."), shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}${r.stderr}`);
}
