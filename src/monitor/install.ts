import { loadConfig } from "../kb/index.js";
import type { ServiceInstaller } from "../approver/launchd.js";

/**
 * `vlad install` içinde monitor servisi (kapı kararı 3): yalnız `monitor.servers` yapılandırılmışsa ve macOS'ta kurulur.
 * `dryRun`: hiçbir şeye dokunmaz, yapılacağı söyler. Yapılandırma yoksa/okunamazsa sessizce atlanır (vlad install'u kırmaz).
 */
export async function monitorInstallActions(o: {
  home: string; cli: string; dryRun: boolean; platform?: NodeJS.Platform; installer?: ServiceInstaller; node?: string; path?: string;
}): Promise<string[]> {
  let configured = false;
  try { configured = (loadConfig(o.home).monitor?.servers.length ?? 0) > 0; } catch { return []; }
  if (!configured) return [];
  if ((o.platform ?? process.platform) !== "darwin") return ["monitor servisi atlandı: yalnız macOS"];
  if (o.dryRun) return ["monitor servisi kurulur (com.vlad.monitor, 5 dk)"];
  const inst = o.installer ?? (await import("./launchd.js")).createMonitorInstaller();
  const steps = await inst.install({ node: o.node ?? process.execPath, cli: o.cli, home: o.home, path: o.path ?? process.env.PATH ?? "" });
  return [`monitor servisi kuruldu (${steps.length} adım)`];
}
