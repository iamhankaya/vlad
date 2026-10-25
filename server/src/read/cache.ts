/** 2 s read cache: repeated polls of the same snapshot share one `vlad` run; concurrent identical misses share it too. */
export const CACHE_TTL_MS = 2000;

export class ReadCache {
  private entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private now: () => number = Date.now, private ttlMs = CACHE_TTL_MS) {}

  /** Failures are not cached: a rejected load is dropped so the next call retries. */
  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && t - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { at: t, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
