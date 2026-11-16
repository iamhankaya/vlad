import type { Ctx } from "./types.js";

/**
 * SÖZLEŞME iskeleti (gövde U4'te). Onaylanan argv'yi alt süreçte çalıştırır: `process.execPath <ctx.cli> <argv>`; keyfi komut çalıştırmaz.
 * Alt süreç ayrı süreç grubunda (`detached`), zaman aşımı LIMITS.execTimeoutMs → SIGTERM, 5 sn sonra SIGKILL (grup); çıktı kırpılır (≤ LIMITS.maxOutputBytes).
 */
export interface Executor {
  run(argv: string[], token: string, ctx: Ctx, deps?: { envExtra?: Record<string, string> }): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;
}

/** Üretim env'i: PATH, HOME (passwd'dan), VLAD_HOME, LANG, VLAD_MODE_TOKEN; VLAD_TASK_ID/USERPROFILE/NODE_OPTIONS yok. */
export function defaultExecEnv(p: { path: string; home: string; vladHome: string; token: string }): NodeJS.ProcessEnv { void p; throw new Error("not implemented"); }

/** Üretim yürütücüsü: sabit env üreticisi; `envExtra` yalnız test deps'inden gelir (üretim yolu `VLAD_*` env'den seam okumaz). */
export function createExecutor(): Executor { throw new Error("not implemented"); }
