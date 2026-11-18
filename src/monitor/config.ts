import type { MonitorConfig } from "./types.js";

/**
 * Yapılandırma dosyasının `monitor` bölümünü okur ve çapraz doğrular (şekil `schemas/config.schema.json`'da): id tekilliği,
 * `project` kb'de kartı olan bir proje. Bölüm yoksa `{ servers: [] }`. Hata `config` (çıkış 2). Gövde uygulama fazında.
 */
export function loadMonitorConfig(_home: string): MonitorConfig {
  throw new Error("not implemented: loadMonitorConfig");
}
