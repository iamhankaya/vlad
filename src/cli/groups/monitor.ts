import { realpathSync } from "node:fs";
import type { Command } from "commander";
import type { Kit } from "../kit.js";
import { SilentExit, type Opts } from "../ctx.js";
import { getVladHome } from "../../kb/index.js";
import { assertNotWorker } from "../../mode/guard.js";
import { requireModeAuthority } from "../../mode/token.js";
import { loadMonitorConfig, MonitorConfigError } from "../../monitor/config.js";
import { exitCodeOf, monitorStatus, pullAlerts } from "../../monitor/pull.js";
import { createKeychainReader } from "../../monitor/secret.js";
import { fmtDuration } from "../../monitor/task-text.js";
import { MONITOR_LIMITS, type MonitorError, type PullDeps, type PullResult, type SecretReader } from "../../monitor/types.js";
import type { ServiceInstaller } from "../../approver/launchd.js";

/**
 * spc köprüsü CLI'ı (T20261119-22). `pull`: kb yazma kilidi (manifest lock "outer"), çalışan reddedilir; çekirdek `src/monitor/pull.ts`.
 * `status`: salt okuma. `install|uninstall`: launchd (`src/monitor/launchd.ts`, dinamik import), TTY + mod yetkisi (`approver install` deseni).
 * Test enjeksiyonu yalnız `registerMonitor(…, deps)` ile; üretim yolu env'den seam okumaz.
 */
export interface MonitorCliDeps {
  secrets?: SecretReader;
  fetch?: typeof fetch;
  stateDir?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  installer?: ServiceInstaller;
  isTTY?: () => boolean;
}

const ago = (ms: number | null, now: number): string => (ms === null ? "hiç" : `${fmtDuration(now - ms)} önce`);

export function registerMonitor(program: Command, k: Kit, deps: MonitorCliDeps = {}): void {
  const { def, out, ctx } = k;
  const monitor = program.command("monitor").description("spc köprüsü: sunucu alarmlarını görev olarak çeker (yalnız macOS)");
  const platform = (): NodeJS.Platform => deps.platform ?? process.platform;

  const installer = async (): Promise<ServiceInstaller> => deps.installer ?? (await import("../../monitor/launchd.js")).createMonitorInstaller();
  const guardPrivileged = (what: string): void => {
    assertNotWorker();
    if (platform() !== "darwin") throw new Error(`monitor ${what} yalnız macOS'ta çalışır`);
    if (!(deps.isTTY ?? (() => process.stdin.isTTY === true))()) throw new Error(`monitor ${what} yalnız etkileşimli terminalde (TTY) çalışır`);
    requireModeAuthority();
  };

  def(monitor, "pull", "Ajanlardan alarmları çeker; critical firing için görev açar, resolved için not düşer", async (o: Opts) => {
    assertNotWorker();
    let result: PullResult;
    try {
      const config = loadMonitorConfig(getVladHome());
      if (config.servers.length === 0) throw new MonitorConfigError("monitor yapılandırması yok (vlad.config.json → monitor.servers)");
      const pd: PullDeps = {
        home: getVladHome(), config, secrets: deps.secrets ?? createKeychainReader(), fetch: deps.fetch,
        stateDir: deps.stateDir, platform: platform(), now: deps.now, log: (l) => ctx.stderr.write(`${l}\n`),
      };
      result = await pullAlerts(pd, { server: typeof o.server === "string" ? o.server : undefined, dryRun: o.dryRun === true });
    } catch (e) {
      if (!(e instanceof MonitorConfigError)) throw e;
      result = { servers: [], errors: [{ server: null, code: "config", message: e.message } satisfies MonitorError] };
    }
    const lines = result.servers.map((s) => `${s.id}: ${s.ok ? "tamam" : "hata"}, çekilen ${s.fetched}, açılan ${s.opened.length}, not ${s.noted.length}, log ${s.logged.length}, atlanan ${s.skipped}`
      + s.opened.map((x) => `\n  görev ${x.task} ← ${x.alert_id}`).join(""));
    for (const e of result.errors) lines.push(`hata [${e.code}]${e.server ? ` ${e.server}` : ""}: ${e.message}`);
    out(o, result, lines.length ? lines.join("\n") : "sunucu yok");
    const code = exitCodeOf(result);
    if (code !== 0) throw new SilentExit(code);
  }).option("--server <ad>", "yalnız bu sunucu").option("--dry-run", "yazma yok; ne yapacağını döker");

  def(monitor, "status", "İmleç, son başarı, ardışık hata, açık eşlemeler ve servis durumu (salt okuma)", async (o: Opts) => {
    const config = loadMonitorConfig(getVladHome());
    const now = (deps.now ?? Date.now)();
    const st = await monitorStatus({ home: getVladHome(), config, stateDir: deps.stateDir, now: deps.now });
    try { st.service = platform() === "darwin" ? await (await installer()).status() : null; } catch { st.service = null; }
    const lines = st.servers.map((s) => `${s.id} → ${s.project}: son başarı ${ago(s.last_ok, now)}${s.unreachable ? `; erişilemez ×${s.fail_streak} (eşik ${MONITOR_LIMITS.failStreakWarn})` : ""}; açık görev ${s.open_tasks.length}`
      + s.open_tasks.map((x) => `\n  ${x.task} ← ${x.alert_id}`).join(""));
    lines.push(`servis: ${st.service ? (st.service.installed ? st.service.detail : "kurulu değil") : "bilinmiyor"}`);
    out(o, st, lines.join("\n"));
  });

  def(monitor, "install", "5 dk'lık launchd servisini kurar (terminalde, mod yetkisiyle)", async (o: Opts) => {
    guardPrivileged("install");
    let cli = ctx.cliPath;
    try { cli = realpathSync(cli); } catch { /* yol çözülemezse olduğu gibi */ }
    const steps = await (await installer()).install({ node: process.execPath, cli, home: getVladHome(), path: process.env.PATH ?? "" });
    out(o, { installed: true, steps }, ["monitor servisi kuruldu:", ...steps.map((s) => `  ${s}`)].join("\n"));
  });
  def(monitor, "uninstall", "launchd servisini kaldırır (terminalde, mod yetkisiyle)", async (o: Opts) => {
    guardPrivileged("uninstall");
    const steps = await (await installer()).uninstall();
    out(o, { uninstalled: true, steps }, ["monitor servisi kaldırıldı:", ...steps.map((s) => `  ${s}`)].join("\n"));
  });
}
