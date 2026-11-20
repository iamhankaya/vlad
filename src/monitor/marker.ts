/** İdempotans işareti: görev gövdesinde tek başına bir satır, anahtar `(server, alert_id)`. Arşivdeki görevler de taranır. */
export const MARKER_PREFIX = "spc-alert: ";
export const ALERT_MARKER_RE = /^spc-alert: ([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9.-]*)$/;

export function alertMarker(server: string, alertId: string): string {
  return `${MARKER_PREFIX}${server}/${alertId}`;
}
/** Satır işaret değilse null. */
export function parseAlertMarker(line: string): { server: string; alertId: string } | null {
  const m = ALERT_MARKER_RE.exec(line);
  return m ? { server: m[1]!, alertId: m[2]! } : null;
}

/** Kapasite işaretleri (plan Karar 3; `alertMarker` kalıbı, mevcut işlevlere dokunmadan): tetikleyici başına architect görevi ve sunucu başına rapor görevi. Gövdede tek başına satır. */
export const CAPACITY_MARKER_PREFIX = "spc-capacity: ";
export const CAPACITY_REPORT_MARKER_PREFIX = "spc-capacity-report: ";
const CAPACITY_MARKER_RE = /^spc-capacity: ([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;
const CAPACITY_REPORT_MARKER_RE = /^spc-capacity-report: ([a-z0-9][a-z0-9-]*)$/;

export const capacityMarker = (server: string, trigger: string): string => `${CAPACITY_MARKER_PREFIX}${server}/${trigger}`;
export function parseCapacityMarker(line: string): { server: string; trigger: string } | null {
  const m = CAPACITY_MARKER_RE.exec(line);
  return m ? { server: m[1]!, trigger: m[2]! } : null;
}
export const capacityReportMarker = (server: string): string => `${CAPACITY_REPORT_MARKER_PREFIX}${server}`;
export function parseCapacityReportMarker(line: string): { server: string } | null {
  const m = CAPACITY_REPORT_MARKER_RE.exec(line);
  return m ? { server: m[1]! } : null;
}
