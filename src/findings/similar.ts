import { listFindingsWithWarnings, UNRESOLVED } from "./store.js";
import type { Finding } from "./store.js";

/** `finding add` warns when an open finding of the same project has a title this close (F-vlad-desktop-166/177 twins; threshold fixed by test). */
export const SIMILAR_THRESHOLD = 0.25;
export const SIMILAR_MIN_MATCHES = 2;
/** Default cap of the related-findings list in a launch prompt. */
export const RELATED_LIMIT = 15;

const FOLD: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" };

/** Lowercase, turkish-folded word set (words of 3+ chars). */
function words(text: string): string[] {
  const t = text.replace(/İ/g, "i").toLowerCase().replace(/[çğıöşü]/g, (c) => FOLD[c]!);
  return [...new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3))];
}

/** Equal, or one is a prefix of the other (both 4+ chars: `wake` ~ `wakesessiontests`, `dinleme` ~ `dinlemesini`). */
const sameWord = (a: string, b: string): boolean => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Normalized word overlap: matched words of the smaller title / its size. */
export function titleSimilarity(a: string, b: string): { matches: number; score: number } {
  const [small, big] = [words(a), words(b)].sort((x, y) => x.length - y.length) as [string[], string[]];
  if (!small.length) return { matches: 0, score: 0 };
  const matches = small.filter((w) => big.some((v) => sameWord(w, v))).length;
  return { matches, score: matches / small.length };
}

const openOf = (project: string): Finding[] => listFindingsWithWarnings({ project, state: [...UNRESOLVED] }).findings;

/** Newest first (created, then id number). */
const newestFirst = (a: Finding, b: Finding): number =>
  b.data.created.localeCompare(a.data.created) || Number(b.data.id.split("-").pop()) - Number(a.data.id.split("-").pop());

/** Open/deferred findings of the project whose title is close to `title`. */
export function similarOpenFindings(project: string, title: string): Finding[] {
  return openOf(project).filter((f) => {
    const s = titleSimilarity(f.data.title, title);
    return s.matches >= SIMILAR_MIN_MATCHES && s.score >= SIMILAR_THRESHOLD;
  });
}

/** Open findings whose title shares a word (4+ chars) with the task text (file/module names); none match → the newest `limit`. */
export function relatedOpenFindings(project: string, taskText: string, limit = RELATED_LIMIT): Finding[] {
  const open = openOf(project).sort(newestFirst);
  const task = words(taskText).filter((w) => w.length >= 4);
  const hits = open.filter((f) => words(f.data.title).some((w) => w.length >= 4 && task.some((t) => sameWord(w, t))));
  return (hits.length ? hits : open).slice(0, limit);
}
