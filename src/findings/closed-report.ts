import { getFinding } from "./store.js";

const FULL_ID = /^F-[a-z0-9-]+-\d+$/;

/** Lines of the report's `### Kapatılan bulgular` section (up to the next heading); empty when absent. */
function sectionLines(md: string): string[] {
  const m = /^###\s+Kapatılan bulgular\s*$/m.exec(md);
  if (!m) return [];
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^#{1,6}\s/m);
  return (end < 0 ? rest : rest.slice(0, end)).split("\n").filter((l) => l.trim().startsWith("-"));
}

/**
 * Warnings for a worker report's `### Kapatılan bulgular` lines: abbreviated/range ids (digest cannot close those),
 * ids with no finding file, ids already closed. Warnings only; a report without the section gets none.
 */
export function closedFindingWarnings(md: string): string[] {
  const warnings: string[] = [];
  for (const line of sectionLines(md)) {
    const first = line.replace(/^\s*-\s*/, "").split(/\s+[—–-]\s+|\s+—\s+/)[0]!.trim().replace(/[`*]/g, "");
    if (!first) continue;
    if (!FULL_ID.test(first)) {
      warnings.push(`kısaltılmış/aralık bulgu ID'si "${first}": tam ID (F-<proje>-NNN) yaz; digest bunu kapatmaz, onaya taşır`);
      continue;
    }
    try {
      const f = getFinding(first);
      if (f.data.state === "fixed" || f.data.state === "wontfix") warnings.push(`${first} zaten kapalı (${f.data.state})`);
    } catch {
      warnings.push(`${first} bilinmiyor (bulgu kaydı yok)`);
    }
  }
  return warnings;
}
