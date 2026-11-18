import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, kbPaths } from "../kb/index.js";
import type { MonitorConfig, MonitorErrorCode } from "./types.js";

/** `config` hatası (çıkış 2). */
export class MonitorConfigError extends Error {
  readonly code: MonitorErrorCode = "config";
  constructor(message: string) { super(message); this.name = "MonitorConfigError"; }
}

/**
 * Yapılandırma dosyasının `monitor` bölümünü okur ve çapraz doğrular (şekil `schemas/config.schema.json`'da): id tekilliği,
 * `project` kb'de kartı olan bir proje. Bölüm yoksa `{ servers: [] }`. Hata `config` (çıkış 2).
 */
export function loadMonitorConfig(home: string): MonitorConfig {
  let cfg;
  try { cfg = loadConfig(home); } catch (e) { throw new MonitorConfigError(`yapılandırma okunamadı: ${(e as Error).message}`); }
  const servers = cfg.monitor?.servers ?? [];
  const seen = new Set<string>();
  for (const s of servers) {
    if (seen.has(s.id)) throw new MonitorConfigError(`monitor: yinelenen sunucu kimliği: ${s.id}`);
    seen.add(s.id);
    if (!existsSync(join(kbPaths().projects, `${s.project}.md`))) throw new MonitorConfigError(`monitor: sunucu ${s.id} için proje kartı yok: ${s.project} (varsayılan projeye düşülmez)`);
  }
  return { servers: servers.map((s) => ({ ...s })) };
}
