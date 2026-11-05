import { resolve } from "node:path";
import { ensureBuild } from "./support/build.js";

/** Builds dist/ once for all test files (parallel per-file `tsc` runs raced on the shared dist/); VLAD_SKIP_BUILD=1 reuses a fresh build. */
export default function setup(): void {
  ensureBuild(resolve(import.meta.dirname, ".."));
}
