const UI_ROLES = new Set(["developer", "game-developer"]);
// the task asks for a UI self-check: "UI öz-kontrol" (any suffix/dash form) or an explicit impeccable audit
const ASKS_UI_CHECK = /\bUI\s+öz[- ]?kontrol|impeccable\s+audit/i;
// the structural line roles/developer.md prescribes (`impeccable audit: <n> bulgu …`), at the start of a line or bullet
const HAS_AUDIT_LINE = /^[\s>*-]*impeccable audit:/im;

/**
 * Warning text for `task report` when a developer/game-developer task asks for a UI self-check (`## Tanım`/body mentions
 * "UI öz-kontrol" or `impeccable audit`) but the closing report has no `impeccable audit:` line; null otherwise.
 * Never blocks: the report is written either way (T20261122-55).
 */
export function uiAuditWarning(task: { role?: string | null; body: string }, report: string): string | null {
  if (!task.role || !UI_ROLES.has(task.role)) return null;
  // only what the task asks for: progress notes, questions and reports (which can mention a UI check) are skipped; text before the first heading counts
  const request = task.body.split(/^(?=## )/m).filter((s) => !/^## (?:İlerleme|Sorular|Kapanış raporu|Önceki raporlar)\b/.test(s)).join("\n");
  if (!ASKS_UI_CHECK.test(request) || HAS_AUDIT_LINE.test(report)) return null;
  return "UI raporunda `impeccable audit: <n> bulgu (kritik/yüksek/orta/düşük), <düzeltilen>/<kalan>` satırı yok; görev UI öz-kontrol istiyor (### Test sonuçları'na ekle ya da neden yapılmadığını Açık noktalar'a yaz)";
}
