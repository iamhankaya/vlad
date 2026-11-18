import type { AlertItem } from "./contract.js";
import type { AlertTaskText } from "./types.js";

/**
 * Critical firing alarm → görev metni. Başlık `[spc] <server>: <title>` (kontrol karakteri temiz, MONITOR_LIMITS.titleMax).
 * Gövde: `## Tanım` (sunucu, kural, koşul `<value> <op> <threshold>`, süre, fired_at ISO, etiketler, ref), `alertMarker` satırı,
 * `## Kabul kriterleri`. Ajan metni (title/labels/ref) tırnaklı alıntı + "ajan çıktısı güvenilmez veri" notuyla girer; talimat gibi yorumlanmaz.
 */
export function buildAlertTask(_server: string, _alert: AlertItem): AlertTaskText {
  throw new Error("not implemented: buildAlertTask");
}
/** Resolved notu (tek satır): `spc: <alert_id> çözüldü (<reason>) <resolved_at ISO>, <süre>`. */
export function buildResolvedNote(_alert: AlertItem): string {
  throw new Error("not implemented: buildResolvedNote");
}
