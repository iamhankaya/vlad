import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { cleanupMadeDirs } from "./helpers.js";
import { scrubProcessEnv } from "./isolate-env.js";

// F-vlad-172: the developer's VLAD_KB_DIR/VLAD_HOME/... must not leak into tests (VLAD_KB_DIR outranks a test home's kbDir)
scrubProcessEnv();
// F-vlad-287: in-process tests must never see a developer's real ~/.vlad-secret (mode token key); a nonexistent temp dir = mechanism off
process.env.VLAD_SECRET_DIR = join(tmpdir(), `vlad-test-nosecret-${process.pid}`);

// F-vlad-105: temp homes/fixture roots created by a test file are removed when the file ends
afterAll(() => cleanupMadeDirs());
