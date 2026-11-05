import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { PersistentHelper } from "./types.js";

// Kalıcı yardımcı süreç: stdin'e bir satır istek, stdout'tan bir satır yanıt. İstekler sıraya girer (aynı anda tek istek uçuşta),
// böylece "sıradaki satır = yanıt" eşleştirmesi yeterlidir. Zaman aşımında ya da çöküşte süreç öldürülür; sonraki istek yenisini başlatır.
// Art arda `maxFailures` (3) başarısız istekten sonra yeniden denenmez (çöküş döngüsü CPU yemesin); bir başarı sayacı sıfırlar.
// Bu modül gerçek süreç başlatır: çağıran (createBackend) gerçek çalıştırıcıdan önce `assertNative` ister.
export function spawnLineHelper(file: string, args: string[], o: { maxFailures?: number } = {}): PersistentHelper {
  const maxFailures = o.maxFailures ?? 3;
  let child: ChildProcess | null = null;
  let waiter: { resolve(l: string): void; reject(e: Error): void; timer: NodeJS.Timeout; c: ChildProcess } | null = null;
  let failures = 0;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const kill = (c: ChildProcess) => { try { c.stdin?.destroy(); } catch { /* kapalı */ } try { c.kill("SIGKILL"); } catch { /* zaten çıktı */ } };
  const fail = (c: ChildProcess, e: Error) => {
    if (waiter && waiter.c === c) { const w = waiter; waiter = null; clearTimeout(w.timer); w.reject(e); }
  };
  const start = (): ChildProcess => {
    const c = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    createInterface({ input: c.stdout! }).on("line", (l) => {
      if (waiter && waiter.c === c) { const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(l); }
    });
    c.stderr!.resume();
    c.stdin!.on("error", () => {}); // EPIPE: çıkış olayı isteği reddeder
    c.on("error", (e) => fail(c, new Error(`pano yardımcısı başlatılamadı: ${e.message}`)));
    c.on("exit", () => { if (child === c) child = null; fail(c, new Error("pano yardımcısı beklenmedik kapandı")); });
    return c;
  };

  const once = async (line: string, timeoutMs: number): Promise<string> => {
    if (closed) throw new Error("pano yardımcısı kapalı");
    if (failures >= maxFailures) throw new Error(`pano yardımcısı ${maxFailures} kez çöktü/yanıtsız kaldı; yeniden denenmiyor`);
    const c = (child ??= start());
    const p = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => fail(c, new Error("pano yardımcısı zaman aşımı")), timeoutMs);
      waiter = { resolve, reject, timer, c };
    });
    try { c.stdin!.write(line + "\n"); } catch (e) { fail(c, e as Error); }
    try { const r = await p; failures = 0; return r; } catch (e) {
      failures++; if (child === c) child = null; kill(c);
      throw e;
    }
  };

  return {
    send(line, timeoutMs) {
      const run = queue.then(() => once(line, timeoutMs));
      queue = run.catch(() => {});
      return run;
    },
    async close() {
      if (closed) return;
      closed = true;
      const c = child; child = null;
      if (!c) return;
      await new Promise<void>((done) => {
        if (c.exitCode !== null || c.signalCode !== null) return done();
        c.once("exit", () => done());
        try { c.stdin!.end(); } catch { /* kapalı */ }
        setTimeout(() => kill(c), 300).unref(); // stdin EOF ile çıkmazsa öldür
        setTimeout(() => done(), 2000).unref();
      });
      kill(c);
    },
  };
}
