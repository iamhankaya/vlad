import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { ServiceInstaller, Launchctl } from "../approver/launchd.js";
import { monitorStateDir } from "./state.js";
import { MONITOR_LIMITS } from "./types.js";

/**
 * macOS launchd servisi (yalnız `vlad monitor install|uninstall` içinde dinamik `import()`; Windows testini kırmaz).
 * Plist `com.vlad.monitor`: `StartInterval 300`, `RunAtLoad`, KeepAlive/AbandonProcessGroup YOK; ProgramArguments `[node, cli, "monitor", "pull"]`;
 * EnvironmentVariables yalnız PATH + VLAD_HOME (sır yok); günlük `~/.vlad-monitor/launchd.log` (0600). Hedef `gui/<uid>/com.vlad.monitor`.
 * Kısmi kurulum (bootstrap başarısız) plist'i geri alır; tekrar install idempotent.
 */
export const MONITOR_LABEL = "com.vlad.monitor";
export const MONITOR_LOG_NAME = "launchd.log";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function monitorPlist(c: { node: string; cli: string; home: string; path: string }, logPath?: string): string {
  const args = [c.node, c.cli, "monitor", "pull"].map((a) => `<string>${esc(a)}</string>`).join("");
  const log = esc(logPath ?? join(monitorStateDir(), MONITOR_LOG_NAME));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${MONITOR_LABEL}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>${MONITOR_LIMITS.launchdIntervalSec}</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(c.path)}</string><key>VLAD_HOME</key><string>${esc(c.home)}</string></dict>
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

const realLaunchctl: Launchctl = (args) => new Promise((resolve) => {
  execFile("launchctl", args, (err, stdout, stderr) => {
    const c = (err as { code?: unknown } | null)?.code;
    resolve({ code: !err ? 0 : typeof c === "number" ? c : 1, stdout: String(stdout), stderr: String(stderr) });
  });
});

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
  const plist = join(opts.plistDir ?? join(opts.homeDir ?? userInfo().homedir, "Library", "LaunchAgents"), `${MONITOR_LABEL}.plist`);
  const stateDir = opts.stateDir ?? (opts.homeDir ? monitorStateDir(opts.homeDir) : monitorStateDir());
  const target = `gui/${process.getuid?.() ?? 501}`;
  return {
    async install(c) {
      const steps: string[] = [];
      mkdirSync(join(plist, ".."), { recursive: true });
      // launchd günlük dosyasını 0600 yapmaz: dizin (0700) altında önceden 0600 oluştur
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      chmodSync(stateDir, 0o700);
      const logPath = join(stateDir, MONITOR_LOG_NAME);
      writeFileSync(logPath, "", { flag: "a", mode: 0o600 });
      chmodSync(logPath, 0o600);
      writeFileSync(plist, monitorPlist(c, logPath), { mode: 0o600 });
      chmodSync(plist, 0o600);
      steps.push(`plist yazıldı: ${plist}`);
      await lc(["bootout", `${target}/${MONITOR_LABEL}`]); // yoksa hata normal (yeniden kurulum idempotent)
      const r = await lc(["bootstrap", target, plist]);
      if (r.code !== 0) { rmSync(plist, { force: true }); throw new Error(`launchctl bootstrap başarısız (${r.code}): ${r.stderr.trim() || r.stdout.trim()}; plist geri alındı`); }
      steps.push("launchctl bootstrap");
      return steps;
    },
    async uninstall() {
      const steps: string[] = [];
      const b = await lc(["bootout", `${target}/${MONITOR_LABEL}`]);
      if (b.code !== 0 && !notLoaded(b)) throw new Error(`launchctl bootout başarısız (${b.code}): ${b.stderr.trim() || b.stdout.trim()}; dosyalar silinmedi`);
      steps.push("launchctl bootout");
      if (existsSync(plist)) { rmSync(plist, { force: true }); steps.push(`plist silindi: ${plist}`); }
      return steps;
    },
    async status() {
      if (!existsSync(plist)) return { installed: false, running: false, detail: "plist yok" };
      const r = await lc(["print", `${target}/${MONITOR_LABEL}`]);
      const running = r.code === 0 && /state = running/.test(r.stdout);
      return { installed: true, running, detail: r.code === 0 ? (running ? "çalışıyor" : "yüklü, bir sonraki çekişi bekliyor") : "plist var, launchd'de yüklü değil" };
    },
  };
}
