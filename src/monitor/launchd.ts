import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { ServiceInstaller, Launchctl } from "../approver/launchd.js";
import { assertTestLaunchctlInjected, assertTestSafeLaunchd, guardLaunchctl, launchdHome } from "../launchd-guard.js";
import { monitorStateDir } from "./state.js";
import { MONITOR_LIMITS } from "./types.js";

/**
 * macOS launchd servisleri (yalnız `vlad monitor install|uninstall` içinde dinamik `import()`; Windows testini kırmaz). İki iş:
 * - `com.vlad.monitor`: `StartInterval 300`, `RunAtLoad`, ProgramArguments `[node, cli, "monitor", "pull"]`, günlük `~/.vlad-monitor/launchd.log`.
 * - `com.vlad.monitor-capacity`: haftalık kapasite raporu; `StartCalendarInterval` pazartesi 09:00 (kaçan çalıştırma uyanınca bir kez koşar), `RunAtLoad` YOK,
 *   `[node, cli, "monitor", "capacity"]`, günlük `~/.vlad-monitor/capacity.log`. Komut ISO hafta idempotenttir (yeniden çalıştırma güvenli).
 * Her ikisinde KeepAlive/AbandonProcessGroup YOK; EnvironmentVariables yalnız PATH + VLAD_HOME (sır yok); günlükler 0600. Hedef `gui/<uid>/<etiket>`.
 * Kısmi kurulum (bootstrap başarısız) o işin plist'ini geri alır; tekrar install idempotent.
 */
export const MONITOR_LABEL = "com.vlad.monitor";
export const MONITOR_LOG_NAME = "launchd.log";
export const CAPACITY_LABEL = "com.vlad.monitor-capacity";
export const CAPACITY_LOG_NAME = "capacity.log";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface PlistSpec { label: string; command: string; schedule: string; runAtLoad: boolean }
function buildPlist(spec: PlistSpec, c: { node: string; cli: string; home: string; path: string }, logPath: string): string {
  const args = [c.node, c.cli, "monitor", spec.command].map((a) => `<string>${esc(a)}</string>`).join("");
  const log = esc(logPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${spec.label}</string>
<key>ProgramArguments</key><array>${args}</array>
${spec.runAtLoad ? "<key>RunAtLoad</key><true/>\n" : ""}${spec.schedule}
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(c.path)}</string><key>VLAD_HOME</key><string>${esc(c.home)}</string></dict>
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

export function monitorPlist(c: { node: string; cli: string; home: string; path: string }, logPath?: string): string {
  return buildPlist({ label: MONITOR_LABEL, command: "pull", runAtLoad: true, schedule: `<key>StartInterval</key><integer>${MONITOR_LIMITS.launchdIntervalSec}</integer>` },
    c, logPath ?? join(monitorStateDir(), MONITOR_LOG_NAME));
}

/** Haftalık kapasite işi: pazartesi (Weekday 1) 09:00 yerel saat. */
export function capacityPlist(c: { node: string; cli: string; home: string; path: string }, logPath?: string): string {
  return buildPlist({ label: CAPACITY_LABEL, command: "capacity", runAtLoad: false, schedule: "<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>" },
    c, logPath ?? join(monitorStateDir(), CAPACITY_LOG_NAME));
}

const rawLaunchctl: Launchctl = (args) => new Promise((resolve) => {
  execFile("launchctl", args, (err, stdout, stderr) => {
    const c = (err as { code?: unknown } | null)?.code;
    resolve({ code: !err ? 0 : typeof c === "number" ? c : 1, stdout: String(stdout), stderr: String(stderr) });
  });
});

const realLaunchctl: Launchctl = guardLaunchctl(rawLaunchctl); // F-vlad-355: test ortamında değiştiren fiiller reddedilir

/** "Servis zaten yüklü değil" çıkışları (ESRCH=3, 113); bunlar uninstall için başarıdır. */
const notLoaded = (r: { code: number; stderr: string }): boolean => r.code === 3 || r.code === 113 || /no such process|could not find (specified )?service/i.test(r.stderr);

/** `opts`: test enjeksiyonu (plist dizini, durum/günlük dizini); üretimde varsayılanlar. */
export interface MonitorInstallerDeps {
  launchctl?: Launchctl;
  plistDir?: string;
  stateDir?: string;
  /** Ana dizin: plist `<homeDir>/Library/LaunchAgents`, günlük/durum `<homeDir>/.vlad-monitor` (testte geçici dizin). */
  homeDir?: string;
}

/** İlk argüman `launchctl` işlevi ya da (test kancası, approver'daki seam gibi) `{ launchctl, plistDir, homeDir }`. */
export function createMonitorInstaller(first?: Launchctl | MonitorInstallerDeps, second: { plistDir?: string; stateDir?: string } = {}): ServiceInstaller {
  const opts: MonitorInstallerDeps = typeof first === "function" ? { launchctl: first, ...second } : { ...(first ?? {}), ...second };
  const lc = opts.launchctl ?? realLaunchctl; // arite 1: sözleşme testi
  const plistDir = opts.plistDir ?? join(opts.homeDir ?? launchdHome(), "Library", "LaunchAgents");
  const stateDir = opts.stateDir ?? (opts.homeDir ? monitorStateDir(opts.homeDir) : monitorStateDir());
  const target = `gui/${process.getuid?.() ?? 501}`;
  const jobs = [
    { label: MONITOR_LABEL, logName: MONITOR_LOG_NAME, make: monitorPlist },
    { label: CAPACITY_LABEL, logName: CAPACITY_LOG_NAME, make: capacityPlist },
  ].map((j) => ({ ...j, plist: join(plistDir, `${j.label}.plist`) }));
  /** F-vlad-355: test ortamında gerçek LaunchAgents'a yazma/silme ve gerçek launchctl reddedilir. */
  const guard = (): void => {
    assertTestSafeLaunchd({ plistDir, injected: opts.plistDir !== undefined || opts.homeDir !== undefined });
    assertTestLaunchctlInjected(opts.launchctl !== undefined);
  };
  return {
    async install(c) {
      guard();
      const steps: string[] = [];
      mkdirSync(plistDir, { recursive: true });
      // launchd günlük dosyasını 0600 yapmaz: dizin (0700) altında önceden 0600 oluştur
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      chmodSync(stateDir, 0o700);
      const loaded: typeof jobs = [];
      for (const j of jobs) {
        const logPath = join(stateDir, j.logName);
        writeFileSync(logPath, "", { flag: "a", mode: 0o600 });
        chmodSync(logPath, 0o600);
        writeFileSync(j.plist, j.make(c, logPath), { mode: 0o600 });
        chmodSync(j.plist, 0o600);
        steps.push(`plist yazıldı: ${j.plist}`);
        await lc(["bootout", `${target}/${j.label}`]); // yoksa hata normal (yeniden kurulum idempotent)
        const r = await lc(["bootstrap", target, j.plist]);
        if (r.code !== 0) {
          rmSync(j.plist, { force: true });
          // yarım kurulum kalmasın: bu çalıştırmada önceden yüklenen işler de geri alınır (en iyi çaba)
          for (const p of loaded.reverse()) { await lc(["bootout", `${target}/${p.label}`]); rmSync(p.plist, { force: true }); }
          throw new Error(`launchctl bootstrap başarısız (${r.code}, ${j.label}): ${r.stderr.trim() || r.stdout.trim()}; plist geri alındı${loaded.length ? "; önceki işler de geri alındı" : ""}`);
        }
        loaded.push(j);
        steps.push(`launchctl bootstrap ${j.label}`);
      }
      return steps;
    },
    async uninstall() {
      guard();
      const steps: string[] = [];
      for (const j of jobs) {
        const b = await lc(["bootout", `${target}/${j.label}`]);
        if (b.code !== 0 && !notLoaded(b)) throw new Error(`launchctl bootout başarısız (${b.code}, ${j.label}): ${b.stderr.trim() || b.stdout.trim()}; dosyalar silinmedi`);
        steps.push(`launchctl bootout ${j.label}`);
      }
      for (const j of jobs) if (existsSync(j.plist)) { rmSync(j.plist, { force: true }); steps.push(`plist silindi: ${j.plist}`); }
      return steps;
    },
    async status() {
      const [pull, cap] = jobs as [typeof jobs[number], typeof jobs[number]];
      const capNote = existsSync(cap.plist)
        ? ((await lc(["print", `${target}/${cap.label}`])).code === 0 ? "; kapasite işi yüklü (pazartesi 09:00)" : "; kapasite plist'i var, launchd'de yüklü değil")
        : "; kapasite işi kurulu değil (vlad monitor install ile eklenir)";
      if (!existsSync(pull.plist)) return { installed: false, running: false, detail: `plist yok${capNote}` };
      const r = await lc(["print", `${target}/${pull.label}`]);
      const running = r.code === 0 && /state = running/.test(r.stdout);
      return { installed: true, running, detail: (r.code === 0 ? (running ? "çalışıyor" : "yüklü, bir sonraki çekişi bekliyor") : "plist var, launchd'de yüklü değil") + capNote };
    },
  };
}
