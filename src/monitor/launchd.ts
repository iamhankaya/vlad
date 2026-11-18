import type { ServiceInstaller, Launchctl } from "../approver/launchd.js";

/**
 * macOS launchd servisi (yalnız `vlad monitor install|uninstall` içinde dinamik `import()`; Windows testini kırmaz).
 * Plist `com.vlad.monitor`: `StartInterval 300`, `RunAtLoad`, KeepAlive/AbandonProcessGroup YOK; ProgramArguments `[node, cli, "monitor", "pull"]`;
 * EnvironmentVariables yalnız PATH + VLAD_HOME (sır yok); günlük `~/.vlad-monitor/launchd.log` (0600). Hedef `gui/<uid>/com.vlad.monitor`.
 * Kısmi kurulum (bootstrap başarısız) plist'i geri alır; tekrar install idempotent. Gövde uygulama fazında.
 */
export const MONITOR_LABEL = "com.vlad.monitor";
export const MONITOR_LOG_NAME = "launchd.log";

export function monitorPlist(_c: { node: string; cli: string; home: string; path: string }, _logPath?: string): string {
  throw new Error("not implemented: monitorPlist");
}
export function createMonitorInstaller(_lc?: Launchctl): ServiceInstaller {
  throw new Error("not implemented: createMonitorInstaller");
}
