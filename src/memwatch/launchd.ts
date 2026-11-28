import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { Launchctl } from "../approver/launchd.js";
import { assertTestLaunchctlInjected, assertTestSafeLaunchd, guardLaunchctl, launchdHome } from "../launchd-guard.js";
import { MONITOR_DIRNAME } from "../monitor/state.js";

/**
 * memwatch daemon launchd işi (`com.vlad.memwatch`; yalnız `vlad memwatch install|uninstall|status` içinde dinamik import).
 * `monitor` işlerinden farkı: süreklidir (10 sn döngü kendi içinde) → `KeepAlive` + `RunAtLoad`, `ProcessType Background`
 * (düşük öncelik), `ThrottleInterval 30` (çökme döngüsünde launchd'yi yormasın). ProgramArguments `[memwatch, "daemon"]`;
 * EnvironmentVariables yalnız PATH (tmux araması); sır yok, ntfy kanalını daemon kendisi okur. Günlük `~/.vlad-monitor/memwatch.log` 0600.
 */
export const MEMWATCH_LABEL = "com.vlad.memwatch";
export const MEMWATCH_LOG_NAME = "memwatch.log";

export interface MemwatchInstaller {
  install(c: { binary: string; path: string }): Promise<string[]>;
  uninstall(): Promise<string[]>;
  status(): Promise<{ installed: boolean; running: boolean; detail: string }>;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function memwatchPlist(c: { binary: string; path: string }, logPath: string): string {
  const log = esc(logPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${MEMWATCH_LABEL}</string>
<key>ProgramArguments</key><array><string>${esc(c.binary)}</string><string>daemon</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(c.path)}</string></dict>
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
const realLaunchctl: Launchctl = guardLaunchctl(rawLaunchctl);

const notLoaded = (r: { code: number; stderr: string }): boolean => r.code === 3 || r.code === 113 || /no such process|could not find (specified )?service/i.test(r.stderr);

export interface MemwatchInstallerDeps {
  launchctl?: Launchctl;
  /** Ana dizin: plist `<homeDir>/Library/LaunchAgents`, günlük `<homeDir>/.vlad-monitor` (testte geçici dizin). */
  homeDir?: string;
}

export function createMemwatchInstaller(o: MemwatchInstallerDeps = {}): MemwatchInstaller {
  const lc = o.launchctl ?? realLaunchctl;
  const home = o.homeDir ?? launchdHome();
  const plistDir = join(home, "Library", "LaunchAgents");
  const stateDir = join(home, MONITOR_DIRNAME);
  const plist = join(plistDir, `${MEMWATCH_LABEL}.plist`);
  const target = `gui/${process.getuid?.() ?? 501}`;
  const guard = (): void => {
    assertTestSafeLaunchd({ plistDir, injected: o.homeDir !== undefined });
    assertTestLaunchctlInjected(o.launchctl !== undefined);
  };
  return {
    async install(c) {
      guard();
      mkdirSync(plistDir, { recursive: true });
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      chmodSync(stateDir, 0o700);
      const logPath = join(stateDir, MEMWATCH_LOG_NAME);
      writeFileSync(logPath, "", { flag: "a", mode: 0o600 });
      chmodSync(logPath, 0o600);
      writeFileSync(plist, memwatchPlist(c, logPath), { mode: 0o600 });
      chmodSync(plist, 0o600);
      await lc(["bootout", `${target}/${MEMWATCH_LABEL}`]); // yoksa hata normal (yeniden kurulum idempotent)
      const r = await lc(["bootstrap", target, plist]);
      if (r.code !== 0) {
        rmSync(plist, { force: true });
        throw new Error(`launchctl bootstrap başarısız (${r.code}, ${MEMWATCH_LABEL}): ${r.stderr.trim() || r.stdout.trim()}; plist geri alındı`);
      }
      return [`plist yazıldı: ${plist}`, `launchctl bootstrap ${MEMWATCH_LABEL}`];
    },
    async uninstall() {
      guard();
      const b = await lc(["bootout", `${target}/${MEMWATCH_LABEL}`]);
      if (b.code !== 0 && !notLoaded(b)) throw new Error(`launchctl bootout başarısız (${b.code}, ${MEMWATCH_LABEL}): ${b.stderr.trim() || b.stdout.trim()}; plist silinmedi`);
      const steps = [`launchctl bootout ${MEMWATCH_LABEL}`];
      if (existsSync(plist)) { rmSync(plist, { force: true }); steps.push(`plist silindi: ${plist}`); }
      return steps;
    },
    async status() {
      if (!existsSync(plist)) return { installed: false, running: false, detail: "plist yok (vlad memwatch install ile kurulur)" };
      const r = await lc(["print", `${target}/${MEMWATCH_LABEL}`]);
      const running = r.code === 0 && /state = running/.test(r.stdout);
      return { installed: true, running, detail: r.code === 0 ? (running ? "çalışıyor" : "yüklü, çalışmıyor") : "plist var, launchd'de yüklü değil" };
    },
  };
}
