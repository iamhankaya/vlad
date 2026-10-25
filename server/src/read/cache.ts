/** 2 s read cache: repeated polls of the same snapshot share one `vlad` run; concurrent identical misses share it too. */
export const CACHE_TTL_MS = 2000;
/** Hard cap on entries: keys can come from client input (a vault path, a search text), so the map must not grow with them. */
export const CACHE_MAX_ENTRIES = 256;

export class ReadCache {
  private entries = new Map<string, { at: number; value: Promise<unknown> }>();

  private now: () => number;
  private ttlMs: number;
  private max: number;

  constructor(now: () => number = Date.now, ttlMs = CACHE_TTL_MS, max = CACHE_MAX_ENTRIES) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Failures are not cached: a rejected load is dropped so the next call retries. */
  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && t - hit.at < this.ttlMs) {
      this.entries.delete(key); // re-insert: Map order is recency, the oldest entry is evicted first
      this.entries.set(key, hit);
      return hit.value as Promise<T>;
    }
    if (hit) this.entries.delete(key);
    const value = load();
    this.entries.set(key, { at: t, value });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
