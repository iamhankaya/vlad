import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * F-vlad-355 (kök neden): approver/monitor/agent kurucuları `plistDir` verilmezse gerçek `~/Library/LaunchAgents`'ı kullanır.
 * Dizin enjekte etmeyen bir test (ör. `approver rotate` + TTY enjeksiyonu) gerçek servisi bootout/silip yeniden kurabiliyordu.
 * Test ortamında (VITEST / NODE_ENV=test) gerçek LaunchAgents'a yazma/silme ve gerçek launchctl'in değiştiren fiilleri reddedilir.
 */
export const inTestEnv = (env: NodeJS.ProcessEnv = process.env): boolean => !!env.VITEST || env.NODE_ENV === "test";

export const realLaunchAgentsDir = (): string => join(userInfo().homedir, "Library", "LaunchAgents");

/** Var olan en yakın atayı realpath'ler, kalan kısmı ekler (henüz yaratılmamış dizin de sembolik bağ üzerinden çözülür). */
function realish(p: string): string {
  let cur = resolve(p), rest = "";
  for (;;) {
    try { return join(realpathSync(cur), rest); } catch { /* yok: üst dizine çık */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest = join(cur.slice(up.length), rest);
    cur = up;
  }
}

const isReal = (plistDir: string): boolean => {
  const a = realish(plistDir), b = realish(realLaunchAgentsDir());
  return a === b || a.startsWith(`${b}/`);
};

/** `injected`: çağıran plist dizinini (plistDir/homeDir) kendisi verdi. Test ortamında verilmemesi ya da gerçek dizin olması hata. */
export function assertTestSafeLaunchd(o: { plistDir: string; injected: boolean; env?: NodeJS.ProcessEnv }): void {
  if (!inTestEnv(o.env)) return;
  if (!o.injected) throw new Error("test ortamı: plist dizini enjekte edilmedi; gerçek ~/Library/LaunchAgents'a yazma/silme reddedildi (plistDir/homeDir ver)");
  if (isReal(o.plistDir)) throw new Error(`test ortamı: gerçek LaunchAgents dizinine (${o.plistDir}) yazma/silme reddedildi; geçici dizin kullan`);
}

type Lc = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const MUTATING = new Set(["bootstrap", "bootout", "kickstart", "load", "unload", "remove", "enable", "disable", "start", "stop", "kill", "submit"]);

/** Gerçek launchctl sarmalayıcısı: test ortamında yalnız salt okuma (`print`, `list`…) geçer. */
export const guardLaunchctl = (lc: Lc, env: NodeJS.ProcessEnv = process.env): Lc => async (args) => {
  if (inTestEnv(env) && MUTATING.has(args[0] ?? "")) throw new Error(`test ortamı: gerçek launchctl ${args[0]} reddedildi (sahte launchctl enjekte et)`);
  return lc(args);
};

/** Gerçek launchctl'i test ortamında kurulum/kaldırmada kullanmayı baştan reddeder (plist yazıldıktan sonra değil). */
export function assertTestLaunchctlInjected(injected: boolean, env?: NodeJS.ProcessEnv): void {
  if (inTestEnv(env) && !injected) throw new Error("test ortamı: gerçek launchctl ile kurulum/kaldırma reddedildi (sahte launchctl enjekte et)");
}
