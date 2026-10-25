/** Token buckets keyed by string; clock injected. Idle buckets are dropped once the map grows. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  private readonly now: () => number;
  readonly capacity: number;
  /** tokens regained per second */
  readonly refillPerSec: number;
  private readonly maxKeys: number;
  private lastSweep = 0;

  constructor(now: () => number, capacity: number, refillPerSec: number, maxKeys = 10_000) {
    this.maxKeys = maxKeys;
    this.now = now;
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
  }

  private level(key: string): { tokens: number; at: number } {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.makeRoom(t);
      b = { tokens: this.capacity, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    return b;
  }

  /** Takes one token; false when empty. */
  take(key: string): boolean {
    const b = this.level(key);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Seconds until one token is available (for `retry_after_s`). */
  retryAfterS(key: string): number {
    const b = this.level(key);
    return b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) / this.refillPerSec);
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Full sweep at most once a second (it is O(n)); the map then has a hard bound: the oldest-created entry goes first. */
  private makeRoom(t: number): void {
    if (t - this.lastSweep >= 1000) {
      this.lastSweep = t;
      for (const [k, b] of this.buckets) if (b.tokens + ((t - b.at) / 1000) * this.refillPerSec >= this.capacity) this.buckets.delete(k);
    }
    while (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
  }
}
