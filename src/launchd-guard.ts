import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * F-vlad-355 (kök neden): approver/monitor/agent kurucuları `plistDir` verilmezse gerçek `~/Library/LaunchAgents`'ı kullanır.
 * Dizin enjekte etmeyen bir test (ör. `approver rotate` + TTY enjeksiyonu) gerçek servisi bootout/silip yeniden kurabiliyordu.
 * Test ortamında (VITEST / NODE_ENV=test) gerçek LaunchAgents'a yazma/silme ve gerçek launchctl'in değiştiren fiilleri reddedilir.
 */
export const inTestEnv = (env: NodeJS.ProcessEnv = process.env): boolean => !!env.VITEST || env.NODE_ENV === "test" || env.VLAD_TEST_GUARD === "1";

/**
 * Kurucuların ev dizini: `HOME` env'i (yoksa userInfo). Geçici HOME'lu test alt süreci gerçek ev dizinini göremez.
 * `realLaunchAgentsDir()` ise bilerek userInfo tabanlı kalır: guard "gerçek" dizini HOME'dan bağımsız tanır.
 */
export const launchdHome = (env: NodeJS.ProcessEnv = process.env): string => env.HOME || userInfo().homedir;

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

const isReal = (plistDir: string, extraRealDir?: string): boolean => {
  const a = realish(plistDir);
  // gerçek ~/Library/LaunchAgents her zaman korunur; `extraRealDir` yalnız ek (testler) — varsayılanın yerine geçmez
  return [realLaunchAgentsDir(), ...(extraRealDir ? [extraRealDir] : [])].some((d) => { const b = realish(d); return a === b || a.startsWith(`${b}/`); });
};

/** `injected`: çağıran plist dizinini (plistDir/homeDir) kendisi verdi. Test ortamında verilmemesi ya da gerçek dizin olması hata. */
export function assertTestSafeLaunchd(o: { plistDir: string; injected: boolean; env?: NodeJS.ProcessEnv; /** yalnız testler: gerçek ~/Library/LaunchAgents'a EK olarak "gerçek" sayılacak dizin (varsayılanın yerine geçmez) */ realDir?: string }): void {
  if (!inTestEnv(o.env)) return;
  if (!o.injected) throw new Error("test ortamı: plist dizini enjekte edilmedi; gerçek ~/Library/LaunchAgents'a yazma/silme reddedildi (plistDir/homeDir ver)");
  if (isReal(o.plistDir, o.realDir)) throw new Error(`test ortamı: gerçek LaunchAgents dizinine (${o.plistDir}) yazma/silme reddedildi; geçici dizin kullan`);
}

type Lc = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const MUTATING = new Set(["bootstrap", "bootout", "kickstart", "load", "unload", "remove", "enable", "disable", "start", "stop", "kill", "submit"]);

/** Gerçek launchctl sarmalayıcısı: test ortamında yalnız salt okuma (`print`, `list`…) geçer. */
export const guardLaunchctl = (lc: Lc, env: NodeJS.ProcessEnv = process.env): Lc => async (args) => {
  if (inTestEnv(env) && MUTATING.has(args[0] ?? "")) throw new Error(`test ortamı: gerçek launchctl ${args[0]} reddedildi (sahte launchctl enjekte et)`);
  return lc(args);
};

/**
 * selfUpdate sağlık bekçisinin (watchdog) `WD_KICK` argv'si: Mac'te `launchctl kickstart -k gui/<uid>/com.vlad.agent`.
 * Test ortamında boş döner, yani gerçek servis yeniden başlatılamaz (guardLaunchctl'in kickstart reddiyle aynı ilke;
 * bekçi ayrı süreçte `spawnSync` ile koştuğu için o sarmalayıcıdan geçmez).
 */
export function watchdogKick(platform: NodeJS.Platform, uid: number | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (inTestEnv(env) || platform !== "darwin" || uid === undefined) return "";
  return JSON.stringify(["launchctl", "kickstart", "-k", `gui/${uid}/com.vlad.agent`]);
}

/** Gerçek launchctl'i test ortamında kurulum/kaldırmada kullanmayı baştan reddeder (plist yazıldıktan sonra değil). */
export function assertTestLaunchctlInjected(injected: boolean, env?: NodeJS.ProcessEnv): void {
  if (inTestEnv(env) && !injected) throw new Error("test ortamı: gerçek launchctl ile kurulum/kaldırma reddedildi (sahte launchctl enjekte et)");
}
