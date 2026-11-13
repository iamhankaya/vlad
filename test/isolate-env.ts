// F-vlad-172: VLAD_* variables of the developer's shell (VLAD_KB_DIR, VLAD_HOME, VLAD_TASK_ID...) must not reach tests or the CLI children they spawn.
// Kept: what vitest.config.ts provides (VLAD_LAUNCHER, VLAD_CLAUDE_JSON, VLAD_NO_NATIVE), VLAD_REAL_KB (opt-in real-kb check, F-vlad-256) and the opt-in golden-update switches.
// Windows env keys are case-insensitive (`vlad_kb_dir` is VLAD_KB_DIR there), so every comparison upper-cases first (F-vlad-186)
const isVlad = (k: string) => k.toUpperCase().startsWith("VLAD_");
const KEEP = (k: string) => {
  const u = k.toUpperCase();
  return u === "VLAD_LAUNCHER" || u === "VLAD_NO_NATIVE" || u === "VLAD_REAL_KB" || u === "VLAD_CLAUDE_JSON" || u.startsWith("VLAD_GOLDEN_");
};

/** Copy of `base` without user VLAD_* variables; spawn helpers use it as their base env. */
export function isolatedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !isVlad(k) || KEEP(k)));
}

/** Removes the same keys from the live process.env (setup file, once per test file). */
export function scrubProcessEnv(): void {
  for (const k of Object.keys(process.env)) if (isVlad(k) && !KEEP(k)) delete process.env[k];
}
