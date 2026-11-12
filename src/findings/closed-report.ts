import { getFinding } from "./store.js";

const FULL_ID = /^F-[a-z0-9-]+-\d+$/;

/**
 * Items of the report's `### Kapatılan bulgular` section (up to the next heading); empty when absent.
 * A bullet line starts an item; following non-bullet, non-blank lines (continuations) are joined to it, so a
 * partial marker on a wrapped line still counts (F-vlad-309).
 */
function sectionLines(md: string): string[] {
  const m = /^###\s+Kapatılan bulgular\s*$/m.exec(md);
  if (!m) return [];
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^#{1,6}\s/m);
  const items: string[] = [];
  for (const raw of (end < 0 ? rest : rest.slice(0, end)).split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (/^[-*]\s/.test(l) || l === "-") items.push(l.replace(/^\*/, "-"));
    else if (items.length) items[items.length - 1] += ` ${l}`;
  }
  return items;
}

/** ASCII-fold Turkish letters so `kismen`/`acik kalir` match like `kısmen`/`açık kalır`. */
const fold = (s: string): string => s.toLocaleLowerCase("tr").replace(/ı/g, "i").replace(/ş/g, "s").replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ö/g, "o").replace(/ü/g, "u");
/** A line that says the finding is only partly fixed / stays open must not close it (F-vlad-309); fail closed. */
const PARTIAL_RE = /kismen|kismi|partially|partial\s*(fix|:)|tam degil|acik kal(ir|iyor|di)(?![a-z])/;
const isPartial = (line: string): boolean => PARTIAL_RE.test(fold(line));
const firstToken = (line: string): string => line.replace(/^\s*-\s*/, "").split(/\s+[—–-]\s+|\s+—\s+/)[0]!.trim().replace(/[`*]/g, "");

/** Ids of `### Kapatılan bulgular` lines marked partial; close skips them and warns. */
export function partialFindingTokens(md: string): string[] {
  return sectionLines(md).filter((l) => isPartial(l)).map(firstToken).filter(Boolean);
}

/** First token (the finding id) of each non-partial `### Kapatılan bulgular` line; may be abbreviated, callers validate it. */
export function closedFindingTokens(md: string): string[] {
  return sectionLines(md).filter((l) => !isPartial(l)).map(firstToken).filter(Boolean);
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
    if (isPartial(line)) { warnings.push(`${first} kısmi düzeltme olarak yazılmış; kapatılmaz (\`### Açık noktalar\` altında [kalan ${first}] yaz)`); continue; }
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
