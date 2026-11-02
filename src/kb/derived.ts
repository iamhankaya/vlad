/**
 * Markers around machine-derived blocks in project cards (counts, active tasks, ... generated from the
 * records). Single source for the writer of those blocks and for `kb lint`, which must not read
 * generated text as a human claim.
 */
export const DERIVED_BLOCK_START = "<!-- vlad:derived:start -->";
export const DERIVED_BLOCK_END = "<!-- vlad:derived:end -->";

/** True for lines inside a derived block (marker lines included). An unclosed block is not trusted: nothing is marked. */
export function derivedLines(lines: string[]): boolean[] {
  const marks = lines.map(() => false);
  let from = -1;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (from < 0) { if (t === DERIVED_BLOCK_START) from = i; } else if (t === DERIVED_BLOCK_END) { marks.fill(true, from, i + 1); from = -1; }
  });
  return marks;
}
