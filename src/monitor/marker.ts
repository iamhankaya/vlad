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
