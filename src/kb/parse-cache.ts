import { constants, lstatSync, readFileSync, statSync } from "node:fs";
import { snapshotId } from "./snapshot.js";

/**
 * Parsed files by path, keyed by mtime/size/inode: one CLI call lists the same kb directory several times
 * (`vlad status`: markStale, markSilentWorkers, summary, countOpenSevere, projectStatus per project) and each
 * pass re-read and re-parsed every file (F-vlad-094, T20261126-25). A write changes the key (atomic writes
 * rename a new inode in, so even a same-tick rewrite does), so a stale entry is never served.
 * `get` returns the shared cached value: callers that hand it out clone it first.
 */
export class ParseCache<T> {
  /** `checked`: the read snapshot (`withReadSnapshot`) the stamp was last verified in */
  private readonly entries = new Map<string, { stamp: string; value?: T; error?: Error; checked?: number }>();

  constructor(
    private readonly parse: (text: string, file: string) => T,
    /** true: a symlink is refused like `readText` (lstat + O_NOFOLLOW, F-vlad-036); false: plain stat/read (task files) */
    private readonly refuseLinks: boolean,
  ) {}

  get(file: string): T {
    const snap = snapshotId();
    let hit = this.entries.get(file);
    if (snap !== null && hit?.checked === snap) { // already stat'ed in this read snapshot
      if (hit.error) throw hit.error;
      return hit.value as T;
    }
    const st = this.refuseLinks ? lstatSync(file, { bigint: true }) : statSync(file, { bigint: true });
    if (this.refuseLinks && st.isSymbolicLink()) { this.entries.delete(file); throw new Error(`symlink okunmaz: ${file}`); }
    const stamp = `${st.mtimeNs}:${st.size}:${st.ino}`;
    if (hit?.stamp !== stamp) {
      // an I/O error (EBUSY during a rename) is transient: thrown, never cached
      const text = this.refuseLinks
        ? readFileSync(file, { encoding: "utf8", flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })
        : readFileSync(file, "utf8");
      try {
        hit = { stamp, value: this.parse(text, file) };
      } catch (e) {
        hit = { stamp, error: e as Error }; // a broken file is not re-parsed until it changes (F-vlad-101)
      }
      this.entries.set(file, hit);
    }
    hit.checked = snap ?? undefined;
    if (hit.error) throw hit.error;
    return hit.value as T;
  }

  /** Drops entries of files no longer listed: archived/deleted files must not pile up in a long-lived process. */
  prune(present: readonly string[]): void {
    const keep = new Set(present);
    for (const k of this.entries.keys()) if (!keep.has(k)) this.entries.delete(k);
  }

  delete(file: string): void { this.entries.delete(file); }

  get size(): number { return this.entries.size; }
}
