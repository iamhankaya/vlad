import type { PullDeps, PullOptions, PullResult, MonitorStatus } from "./types.js";

/**
 * `vlad monitor pull` çekirdeği. Kural (D-server-pulse-counter-004): `severity === "critical" && state === "firing"` (suppressed dahil) → bir
 * `research`/`analyst` görevi (queued, başlatılmaz); diğerleri log; `vlad` alanı yalnız bastırma (`none` → log yok). `resolved` → açık görevin
 * `## İlerleme`'sine tek not (görev kapanmaz; kapalı/yok → yazma yok). İdempotans: durum dosyası + gövde işareti (arşiv dahil).
 * Şema/yetki/erişim hatası o sunucuyu atlar (imleç ilerlemez), diğerleri sürer. Gövde uygulama fazında.
 */
export async function pullAlerts(_deps: PullDeps, _opts: PullOptions = {}): Promise<PullResult> {
  throw new Error("not implemented: pullAlerts");
}
/** Çıkış kodu: errors'taki en kötü EXIT_BY_CODE. */
export function exitCodeOf(_r: PullResult): 0 | 1 | 2 {
  throw new Error("not implemented: exitCodeOf");
}
/** `vlad monitor status` verisi (salt okuma). */
export async function monitorStatus(_deps: Omit<PullDeps, "secrets" | "fetch">): Promise<MonitorStatus> {
  throw new Error("not implemented: monitorStatus");
}
