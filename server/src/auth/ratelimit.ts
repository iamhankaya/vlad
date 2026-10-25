/** Token buckets keyed by string; clock injected. Idle buckets are dropped once the map grows. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  private readonly now: () => number;
  readonly capacity: number;
  /** tokens regained per second */
  readonly refillPerSec: number;

  constructor(now: () => number, capacity: number, refillPerSec: number) {
    this.now = now;
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
  }

  private level(key: string): { tokens: number; at: number } {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size > 10_000) this.sweep(t);
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

  private sweep(t: number): void {
    for (const [k, b] of this.buckets) if (b.tokens + ((t - b.at) / 1000) * this.refillPerSec >= this.capacity) this.buckets.delete(k);
  }
}
