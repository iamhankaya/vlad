import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { guardLaunchctl, inTestEnv } from "../launchd-guard.js";
import { taskkillPath } from "./proc.js";

export interface RunResult { code: number; stdout: string; stderr: string }

export interface StopDeps {
  platform: NodeJS.Platform;
  uid: number;
  run(file: string, args: string[]): Promise<RunResult>;
  /** yerel Agent ping'e yanıt veriyor mu */
  probe(): Promise<boolean>;
  readPid(): number | null;
  isAlive(pid: number): boolean;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
  waitMs?: number;
  pollMs?: number;
}

export interface StopResult {
  stopped: boolean;
  wasRunning: boolean;
  method: "launchd-bootout" | "schtasks-end" | "signal" | "none";
  note: string;
}

export const LAUNCHD_LABEL = "com.vlad.agent";
export const WIN_TASK = "VladAgent";

/** launchd: "kayıtlı değil" çıkışları (ESRCH=3, 113 "Could not find service"). */
const notLoaded = (r: RunResult): boolean => r.code === 3 || r.code === 113 || /no such process|could not find (specified )?service/i.test(r.stderr);

/**
 * `vlad agent stop`: yerel Agent'ı durdurur; `agent install` ile kurulan kayda göre.
 * Mac: launchd'de yüklüyse `launchctl bootout` (KeepAlive=true olduğu için kill/SIGTERM işi yeniden başlatırdı). Bootout işi launchd'den
 * çıkarır; plist dosyası durur, bu yüzden durdurma GEÇİCİDİR: sonraki oturum açılışında RunAtLoad yeniden başlatır.
 * Windows: `schtasks /End` çalışan örneği sonlandırır; görev silinmez/devre dışı kalmaz, sonraki oturum açılışında yeniden başlar.
 * Kayıt yoksa (elle `agent start` ile açılmış): pid dosyasındaki sürece sinyal.
 */
export async function agentStop(d: StopDeps): Promise<StopResult> {
  const wasRunning = await d.probe();
  if (!wasRunning) return { stopped: true, wasRunning: false, method: "none", note: "Agent zaten çalışmıyor" };
  let method: StopResult["method"] | null = null;
  let note = "";
  if (d.platform === "darwin") {
    const target = `gui/${d.uid}/${LAUNCHD_LABEL}`;
    const pr = await d.run("launchctl", ["print", target]);
    if (pr.code === 0) {
      const r = await d.run("launchctl", ["bootout", target]);
      if (r.code !== 0 && !notLoaded(r)) throw new Error(`agent stop: launchctl bootout başarısız (kod ${r.code}): ${(r.stderr || r.stdout).trim()}`);
      method = "launchd-bootout";
      note = "launchd işi çıkarıldı (bootout); KeepAlive yeniden başlatmaz. Durdurma geçici: plist yerinde kalır, sonraki oturum açılışında Agent yeniden başlar. Hemen geri getirmek için `vlad agent install --apply` (bootstrap) ya da `vlad agent start`; kalıcı kapatma için plist'i kaldır.";
    }
  } else if (d.platform === "win32") {
    const r = await d.run("schtasks", ["/End", "/TN", WIN_TASK]);
    if (r.code === 0) {
      method = "schtasks-end";
      note = `zamanlanmış görev (${WIN_TASK}) durduruldu; görev silinmedi, sonraki oturum açılışında Agent yeniden başlar. Kalıcı kapatma: schtasks /Change /TN ${WIN_TASK} /DISABLE`;
    }
  }
  if (!method) {
    const pid = d.readPid();
    if (pid === null || !d.isAlive(pid)) throw new Error("agent stop: durdurulacak süreç bulunamadı (launchd/zamanlanmış görev kaydı yok, pid dosyası boş ya da süreç ölü); Agent başka biçimde çalışıyor olabilir");
    d.kill(pid);
    method = "signal";
    note = `pid ${pid} sonlandırıldı (kayıtlı servis yok: elle başlatılmış Agent); yeniden başlatan bir şey yok, \`vlad agent start\` ile açılır`;
  }
  const deadline = Date.now() + (d.waitMs ?? 10_000);
  while (await d.probe()) {
    if (Date.now() >= deadline) throw new Error(`agent stop: ${method} çalıştı ama Agent durmadı (hâlâ yanıt veriyor); \`vlad agent status\` ile bak`);
    await d.sleep(d.pollMs ?? 250);
  }
  return { stopped: true, wasRunning: true, method, note };
}

const rawRun = (file: string, args: string[]): Promise<RunResult> => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) => {
    const c = (err as { code?: unknown } | null)?.code;
    resolve({ code: !err ? 0 : typeof c === "number" ? c : 1, stdout: String(stdout), stderr: String(stderr) });
  });
});

/** Gerçek bağımlılıklar. Test ortamında launchctl değiştiren fiilleri (bootout) guard reddeder; schtasks/sinyal de test ortamında reddedilir. */
export function realStopDeps(o: { probe: () => Promise<boolean>; pidFile: string }): StopDeps {
  const launchctl = guardLaunchctl((args) => rawRun("launchctl", args));
  return {
    platform: process.platform, uid: process.getuid?.() ?? 501,
    run: (file, args) => {
      if (file === "launchctl") return launchctl(args);
      if (inTestEnv()) return Promise.reject(new Error(`test ortamı: gerçek ${file} reddedildi (sahte run enjekte et)`));
      return rawRun(file, args);
    },
    probe: o.probe,
    readPid: () => (existsSync(o.pidFile) ? Number(readFileSync(o.pidFile, "utf8")) || null : null),
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } },
    kill: (pid) => {
      if (inTestEnv()) throw new Error("test ortamı: gerçek süreç sonlandırma reddedildi (sahte kill enjekte et)");
      if (process.platform === "win32") void rawRun(taskkillPath(), ["/PID", String(pid), "/T", "/F"]);
      else process.kill(pid, "SIGTERM");
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
