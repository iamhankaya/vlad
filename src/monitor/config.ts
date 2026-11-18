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
    const bad = checkAgentUrl(s.agent_url);
    if (bad) throw new MonitorConfigError(`monitor: sunucu ${s.id}: agent_url ${bad}`);
    if (!existsSync(join(kbPaths().projects, `${s.project}.md`))) throw new MonitorConfigError(`monitor: sunucu ${s.id} için proje kartı yok: ${s.project} (varsayılan projeye düşülmez)`);
  }
  return { servers: servers.map((s) => ({ ...s })) };
}

/** [a, b, önek]: önek 8 → yalnız a eşleşir; 16 → a.b eşleşir. */
const PRIVATE_V4: Array<[number, number, number]> = [[10, 0, 8], [127, 0, 8], [169, 254, 16], [192, 168, 16]];
function privateV4(h: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((x) => x > 255)) return false;
  if (PRIVATE_V4.some(([x, y, p]) => a === x && (p === 8 || b === y))) return true;
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  return a === 100 && b >= 64 && b <= 127; // CGNAT 100.64/10 (Tailscale)
}
function privateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = privateV4(h);
  if (v4 !== null) return v4;
  if (h.includes(":")) return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h); // loopback, ULA, link-local
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".ts.net");
}

/** `agent_url` sözleşmesi: yalnız origin (kimlik bilgisi/sorgu/parça/ek yol yok); düz `http:` yalnız loopback/özel ağ/Tailscale. Sorun yoksa null. İleti kimlik bilgisini yankılamaz. */
export function checkAgentUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "ayrıştırılamadı"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "yalnız http(s) olabilir";
  if (u.username || u.password) return "kimlik bilgisi (kullanıcı:parola@) içeremez";
  if (u.search || u.hash) return "sorgu ya da parça içeremez";
  if (u.pathname !== "/" && u.pathname !== "") return "yol içeremez (yalnız origin; /spc/v1/alerts eklenir)";
  if (u.protocol === "http:" && !privateHost(u.hostname)) return `düz http yalnız loopback/özel ağ adreslerinde kabul edilir (${u.host}); belirteç açık metin gider, https kullanın`;
  return null;
}
