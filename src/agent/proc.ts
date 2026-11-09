import { spawn } from "node:child_process";
import { win32 } from "node:path";

/** `taskkill` PATH'ten değil `%SystemRoot%\System32`'den (PATH önceliği ile sahte taskkill.exe çalışmasın). */
export const taskkillPath = (systemRoot: string | undefined = process.env.SystemRoot): string => win32.join(systemRoot || "C:\\Windows", "System32", "taskkill.exe");

/** Süreci torunlarıyla öldürür: Windows'ta `taskkill /T /F`, POSIX'te süreç grubu (spawn `detached: true` ile açılmış olmalı). */
export function killTree(p: ReturnType<typeof spawn>): void {
  // Windows'ta p.kill() yalnız cmd.exe'yi öldürür; torunlar (npm test…) boruları tutar
  if (process.platform === "win32" && p.pid) spawn(taskkillPath(), ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => p.kill());
  else if (p.pid) { try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); } } // detached: süreç grubu lideri; torunlar da gider
  else p.kill();
}

export interface KillDeps {
  platform?: NodeJS.Platform;
  /** taskkill çıkış kodu; başlatılamazsa null */
  spawnTaskkill?: (pid: number) => Promise<number | null>;
  /** POSIX: negatif pid = süreç grubu */
  signalGroup?: (pid: number) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** ölümü bekleme tavanı (varsayılan 10 sn) */
  waitMs?: number;
  pollMs?: number;
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const runTaskkill = (pid: number): Promise<number | null> => new Promise((res) => {
  const t = spawn(taskkillPath(), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  t.on("error", () => res(null)); t.on("close", (c) => res(c));
});

/**
 * Süreç ağacını öldürür ve GERÇEKTEN bittiğini bekler (F-vlad-270). true = doğrulandı; false = doğrulanamadı (taskkill başarısız ya da kök pid / süreç grubu
 * `waitMs` içinde ölmedi): çağıran yarım işi geri almamalı (npm/tsc hâlâ node_modules'a yazıyor olabilir).
 * Windows: taskkill çıkışı beklenir (0 ya da 128 = süreç yok) + kök pid ölümü; POSIX: süreç grubuna SIGKILL + grubun yok olması (spawn `detached: true` gerekir).
 */
export async function killTreeWait(p: Pick<ReturnType<typeof spawn>, "pid" | "kill">, d: KillDeps = {}): Promise<boolean> {
  const pid = p.pid;
  if (!pid) return true;
  const win = (d.platform ?? process.platform) === "win32";
  const isAlive = d.isAlive ?? alive, sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = d.waitMs ?? 10_000, pollMs = d.pollMs ?? 100;
  let target = pid;
  if (win) {
    const code = await (d.spawnTaskkill ?? runTaskkill)(pid);
    if (code !== 0 && code !== 128) { try { p.kill(); } catch { /* yok */ } return false; }
  } else {
    target = -pid;
    try { (d.signalGroup ?? ((g) => process.kill(g, "SIGKILL")))(target); } catch { try { p.kill("SIGKILL"); } catch { /* yok */ } }
  }
  for (let waited = 0; ; waited += pollMs) {
    if (!isAlive(target)) return true;
    if (waited >= waitMs) return false;
    await sleep(pollMs);
  }
}
