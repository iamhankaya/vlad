// F-vlad-172: VLAD_* variables of the developer's shell (VLAD_KB_DIR, VLAD_HOME, VLAD_TASK_ID...) must not reach tests or the CLI children they spawn.
// Kept: what vitest.config.ts provides (VLAD_LAUNCHER, VLAD_CLAUDE_JSON, VLAD_NO_NATIVE) and the opt-in golden-update switches.
const KEEP = (k: string) => k === "VLAD_LAUNCHER" || k === "VLAD_NO_NATIVE" || k === "VLAD_CLAUDE_JSON" || k.startsWith("VLAD_GOLDEN_");

/** Copy of `base` without user VLAD_* variables; spawn helpers use it as their base env. */
export function isolatedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("VLAD_") || KEEP(k)));
}

/** Removes the same keys from the live process.env (setup file, once per test file). */
export function scrubProcessEnv(): void {
  for (const k of Object.keys(process.env)) if (k.startsWith("VLAD_") && !KEEP(k)) delete process.env[k];
}
