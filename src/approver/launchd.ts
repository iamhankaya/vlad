import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { approverDir } from "../mode/token.js";
import { userInfo } from "node:os";
import { join } from "node:path";
import { assertTestLaunchctlInjected, assertTestSafeLaunchd, guardLaunchctl } from "../launchd-guard.js";

/**
 * SÖZLEŞME iskeleti (gövde U5'te). macOS launchd; yalnız `approver` CLI grubunda dinamik `import()` ile yüklenir (Windows testini kırmaz).
 * Plist: `com.vlad.approver`, `RunAtLoad`, `KeepAlive`, `ThrottleInterval 10`; `AbandonProcessGroup` YOK (mevcut agent plist'inin `true`'su kopyalanmaz).
 * Kısmi kurulum (plist yazıldı, bootstrap başarısız) geri alınır. Stub `approver run` ile gerçek `install` ASLA denenmez (KeepAlive döngüsü).
 */
export interface ServiceInstaller {
  install(c: { node: string; cli: string; home: string; path: string }): Promise<string[]>;
  uninstall(): Promise<string[]>;
  status(): Promise<{ installed: boolean; running: boolean; detail: string }>;
}
/** `launchctl` çağrıcısı enjekte edilebilir (testte sahte). */
export type Launchctl = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const LABEL = "com.vlad.approver";
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plist: agent plist'inden farklı olarak AbandonProcessGroup YOK (servis ölürse çocuk işlem grubu da gitmeli); ortamda token/sır yok. */
export function approverPlist(c: { node: string; cli: string; home: string; path: string }, logPath?: string): string {
  const args = [c.node, c.cli, "approver", "run"].map((a) => `<string>${esc(a)}</string>`).join("");
  const log = esc(logPath ?? join(c.home, ".vlad-approver.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(c.path)}</string><key>VLAD_HOME</key><string>${esc(c.home)}</string></dict>
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

const rawLaunchctl: Launchctl = (args) => new Promise((resolve) => {
  execFile("launchctl", args, (err, stdout, stderr) => {
    const c = (err as { code?: unknown } | null)?.code;
    resolve({ code: !err ? 0 : typeof c === "number" ? c : 1, stdout: String(stdout), stderr: String(stderr) });
  });
});

const realLaunchctl: Launchctl = guardLaunchctl(rawLaunchctl); // F-vlad-355: test ortamında değiştiren fiiller reddedilir

/** "Servis zaten yüklü değil" çıkışları (ESRCH=3, 113 "Could not find service"); bunlar uninstall için başarıdır. */
const notLoaded = (r: { code: number; stderr: string }): boolean => r.code === 3 || r.code === 113 || /no such process|could not find (specified )?service/i.test(r.stderr);
const realSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** F-vlad-355: yaşam döngüsü adımları approver.log'a zaman damgalı satır olarak yazılır (servis sessizce kalkarsa iz kalsın). En iyi çaba; sır yok (yollar/kodlar). */
function lifecycleLog(line: string): void {
  try {
    const dir = approverDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, "approver.log"), `${new Date().toISOString()} launchd: ${line.replace(/[\r\n]+/g, " ").slice(0, 500)}\n`, { mode: 0o600 });
  } catch { /* günlük yazılamazsa kurulum/kaldırma bozulmaz */ }
}

export function createLaunchdInstaller(deps: { launchctl?: Launchctl; plistDir?: string; homeDir?: string; sleep?: (ms: number) => Promise<void> } = {}): ServiceInstaller {
  const sleep = deps.sleep ?? realSleep;
  const lc = deps.launchctl ?? realLaunchctl;
  const plistDir = deps.plistDir ?? join(userInfo().homedir, "Library", "LaunchAgents");
  const plist = join(plistDir, `${LABEL}.plist`);
  /** F-vlad-355: test ortamında gerçek LaunchAgents'a yazma/silme ve gerçek launchctl ile kurulum/kaldırma reddedilir (değiştiren adımların en başında). */
  const guard = (): void => {
    assertTestSafeLaunchd({ plistDir, injected: deps.plistDir !== undefined });
    assertTestLaunchctlInjected(deps.launchctl !== undefined);
  };
  const target = `gui/${process.getuid?.() ?? 501}`;
  return {
    async install(c) {
      guard();
      const steps: string[] = [];
      lifecycleLog(`install başladı (plist ${plist})`);
      mkdirSync(join(plist, ".."), { recursive: true });
      // launchd günlük dosyasını 0600 yapmaz: approver dizini (0700) altında önceden 0600 oluştur
      const dir = approverDir(), logPath = join(dir, "launchd.log");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(logPath, "", { flag: "a", mode: 0o600 });
      chmodSync(logPath, 0o600);
      for (const h of new Set([c.home, deps.homeDir ?? userInfo().homedir])) rmSync(join(h, ".vlad-approver.log"), { force: true }); // eski günlük (F-vlad-346c); yalnız o dosya
      writeFileSync(plist, approverPlist(c, logPath), { mode: 0o600 });
      chmodSync(plist, 0o600);
      steps.push(`plist yazıldı: ${plist}`);
      await lc(["bootout", `${target}/${LABEL}`]); // yoksa hata normal (yeniden kurulum idempotent)
      const r = await lc(["bootstrap", target, plist]);
      if (r.code !== 0) {
        rmSync(plist, { force: true });
        lifecycleLog(`bootstrap başarısız (${r.code}): ${r.stderr.trim() || r.stdout.trim()}; plist geri alındı`);
        throw new Error(`launchctl bootstrap başarısız (${r.code}): ${r.stderr.trim() || r.stdout.trim()}; plist geri alındı`);
      }
      steps.push("launchctl bootstrap");
      lifecycleLog("bootstrap başarılı");
      return steps;
    },
    async uninstall() {
      guard();
      const steps: string[] = [];
      lifecycleLog("uninstall başladı");
      const b = await lc(["bootout", `${target}/${LABEL}`]);
      if (b.code !== 0 && !notLoaded(b)) {
        lifecycleLog(`bootout başarısız (${b.code}): ${b.stderr.trim() || b.stdout.trim()}; dosyalar silinmedi`);
        throw new Error(`launchctl bootout başarısız (${b.code}): ${b.stderr.trim() || b.stdout.trim()}; dosyalar silinmedi`);
      }
      steps.push("launchctl bootout");
      for (let i = 0; ; i++) { // sonlanmayı doğrula: servis hâlâ yüklü/çalışıyorsa dosyalara dokunma
        const r = await lc(["print", `${target}/${LABEL}`]);
        if (r.code !== 0 || !/state = running/.test(r.stdout)) break;
        if (i >= 9) { lifecycleLog("servis bootout sonrası sonlanmadı; dosyalar silinmedi"); throw new Error("servis bootout sonrası sonlanmadı; dosyalar silinmedi"); }
        await sleep(200);
      }
      if (existsSync(plist)) { rmSync(plist, { force: true }); steps.push(`plist silindi: ${plist}`); lifecycleLog(`plist silindi: ${plist}`); }
      return steps;
    },
    async status() {
      if (!existsSync(plist)) return { installed: false, running: false, detail: "plist yok" };
      const r = await lc(["print", `${target}/${LABEL}`]);
      const running = r.code === 0 && /state = running/.test(r.stdout);
      return { installed: true, running, detail: r.code === 0 ? (running ? "çalışıyor" : "yüklü, çalışmıyor") : "plist var, launchd'de yüklü değil" };
    },
  };
}
