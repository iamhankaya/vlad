/**
 * Read snapshot (T20261126-25): inside `withReadSnapshot` a kb directory is listed once and each cached file is
 * stat'ed once (`listMdFiles`, `ParseCache`), so `vlad status` / `project status` no longer re-list and re-stat
 * ~1.700 task files per project. It is meant for read-only stretches: every kb write (`writeFileAtomic`) ends the
 * current view, and leaving the outermost scope does too. Synchronous only: an async callback keeps the snapshot
 * for its synchronous part, nothing after the first `await`.
 */
let depth = 0;
let generation = 0;

export function withReadSnapshot<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
    if (depth === 0) generation++;
  }
}

/** The current view's id, or null outside a snapshot (memos taken under another id are stale). */
export function snapshotId(): number | null {
  return depth > 0 ? generation : null;
}

/** A kb write happened: whatever the current snapshot remembered may be stale now. */
export function invalidateSnapshot(): void {
  generation++;
}
