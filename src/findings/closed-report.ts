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

/** A line that says the finding is only partly fixed / stays open must not close it (F-vlad-309). */
const PARTIAL = /kısmen|kısmi|partial|açık kal|bulgu açık|açık kalır/i;
const firstToken = (line: string): string => line.replace(/^\s*-\s*/, "").split(/\s+[—–-]\s+|\s+—\s+/)[0]!.trim().replace(/[`*]/g, "");

/** Ids of `### Kapatılan bulgular` lines marked partial; close skips them and warns. */
export function partialFindingTokens(md: string): string[] {
  return sectionLines(md).filter((l) => PARTIAL.test(l)).map(firstToken).filter(Boolean);
}

/** First token (the finding id) of each non-partial `### Kapatılan bulgular` line; may be abbreviated, callers validate it. */
export function closedFindingTokens(md: string): string[] {
  return sectionLines(md).filter((l) => !PARTIAL.test(l)).map((line) => line.replace(/^\s*-\s*/, "").split(/\s+[—–-]\s+|\s+—\s+/)[0]!.trim().replace(/[`*]/g, "")).filter(Boolean);
}
export const isFullFindingId = (s: string): boolean => FULL_ID.test(s);

/**
 * Warnings for a worker report's `### Kapatılan bulgular` lines: abbreviated/range ids (digest cannot close those),
 * ids with no finding file, ids already closed. Warnings only; a report without the section gets none.
 */
export function closedFindingWarnings(md: string): string[] {
  const warnings: string[] = [];
  for (const line of sectionLines(md)) {
    const first = firstToken(line);
    if (!first) continue;
    if (PARTIAL.test(line)) { warnings.push(`${first} kısmi düzeltme olarak yazılmış; kapatılmaz (\`### Açık noktalar\` altında [kalan ${first}] yaz)`); continue; }
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
