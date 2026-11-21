import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { consoleTimeoutMs } from "../commands/accessors.js";
import { LIMITS, type Ctx } from "./types.js";

/**
 * Onaylanan argv'yi alt süreçte çalıştırır: `process.execPath <ctx.cli> <argv>`; keyfi komut çalıştırmaz.
 * Alt süreç ayrı süreç grubunda (`detached`), zaman aşımı LIMITS.execTimeoutMs → SIGTERM, 5 sn sonra SIGKILL (grup); çıktı kırpılır (≤ LIMITS.maxOutputBytes).
 * `signal` iptali (servis durdurma) de aynı yolla grubu öldürür ve `aborted: true` döner.
 */
export interface Executor {
  run(argv: string[], token: string, ctx: Ctx, deps?: { envExtra?: Record<string, string>; signal?: AbortSignal }): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; aborted?: boolean }>;
}

/** Üretim env'i: PATH, HOME (passwd'dan), VLAD_HOME, LANG, VLAD_MODE_TOKEN ve doğrulanmış ctx.kb'den VLAD_KB_DIR (onaylanan komut bildirilen kb'yi değiştirir); VLAD_TASK_ID/USERPROFILE/NODE_OPTIONS yok. */
export function defaultExecEnv(p: { path: string; home: string; vladHome: string; token: string; kb?: string }): NodeJS.ProcessEnv {
  return { PATH: p.path, HOME: p.home, VLAD_HOME: p.vladHome, LANG: "en_US.UTF-8", ...(p.token ? { VLAD_MODE_TOKEN: p.token } : {}), ...(p.kb ? { VLAD_KB_DIR: p.kb } : {}) };
}

/** F-vlad-360: yürütme süresi komutun manifest süre politikasından türer (task gate 31 dk vb.); en az LIMITS.execTimeoutMs. */
export const execTimeoutFor = (argv: readonly string[]): number => Math.max(LIMITS.execTimeoutMs, consoleTimeoutMs(argv));

/** Test için kısa değerler; üretim yolu varsayılanları kullanır. */
export interface ExecOpts { timeoutMs?: number; killGraceMs?: number; maxOutputBytes?: number }

/** Üretim yürütücüsü: sabit env üreticisi; `envExtra` yalnız test deps'inden gelir (üretim yolu `VLAD_*` env'den seam okumaz). */
export function createExecutor(opts: ExecOpts = {}): Executor {
  const graceMs = opts.killGraceMs ?? 5000, cap = opts.maxOutputBytes ?? LIMITS.maxOutputBytes;
  return {
    run(argv, token, ctx, deps) {
      const timeoutMs = opts.timeoutMs ?? execTimeoutFor(argv);
      const env = { ...defaultExecEnv({ path: process.env.PATH ?? "/usr/bin:/bin", home: userInfo().homedir, vladHome: ctx.home, token, kb: ctx.kb }), ...deps?.envExtra };
      return new Promise((resolve) => {
        const out: Buffer[] = [], err: Buffer[] = [];
        const sizes = { out: 0, err: 0 };
        const keep = (chunks: Buffer[], k: "out" | "err") => (c: Buffer) => { // bellek sınırlı: sınırdan fazlası atılır, boru boşaltılmaya devam eder
          const room = cap - sizes[k];
          if (room > 0) { const b = c.subarray(0, room); chunks.push(b); sizes[k] += b.length; }
        };
        let timedOut = false, aborted = false, settled = false;
        const timers: NodeJS.Timeout[] = [];
        const child = spawn(process.execPath, [ctx.cli, ...argv], { env, detached: true, stdio: ["ignore", "pipe", "pipe"], ...(existsSync(ctx.home) ? { cwd: ctx.home } : {}) });
        const killGroup = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* grup yok */ } };
        const stop = () => { killGroup("SIGTERM"); timers.push(setTimeout(() => killGroup("SIGKILL"), graceMs)); };
        const onAbort = () => { aborted = true; stop(); };
        const finish = (exitCode: number | null, extraErr = "") => {
          if (settled) return;
          settled = true;
          timers.forEach(clearTimeout);
          deps?.signal?.removeEventListener("abort", onAbort);
          if (timedOut || aborted) killGroup("SIGKILL"); // SIGTERM'i yok sayan torunlar kalmasın
          resolve({ exitCode, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat([...err, Buffer.from(extraErr)]).toString("utf8").slice(0, cap), timedOut, ...(aborted ? { aborted } : {}) });
        };
        child.stdout.on("data", keep(out, "out"));
        child.stderr.on("data", keep(err, "err"));
        child.on("error", (e) => finish(null, e.message));
        child.on("close", (code) => finish(code));
        timers.push(setTimeout(() => { timedOut = true; stop(); }, timeoutMs));
        if (deps?.signal?.aborted) onAbort(); else deps?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
