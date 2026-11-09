import { FAILING_STATUSES, type PartCheck } from "./types.js";

/** Çıkış kodu sözleşmesi: error ağırlıklı eksik/eski/çakışan → 1; warn yalnız `strict`; info asla. */
export function exitCodeFor(parts: readonly PartCheck[], strict: boolean): 0 | 1 {
  return parts.some((p) => FAILING_STATUSES.includes(p.status) && (p.severity === "error" || (strict && p.severity === "warn"))) ? 1 : 0;
}
