import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/auth/ratelimit.ts";
import { REPLAY_TTL_MS, ReplayCache } from "../../src/auth/replay.ts";
import { Clock, tmpState } from "../helpers/client.ts";

describe("ReplayCache", () => {
  it("claims once and survives a restart", () => {
    const dir = tmpState();
    const clock = new Clock();
    expect(new ReplayCache(dir, clock.now).claim("n:d:x")).toBe(true);
    const again = new ReplayCache(dir, clock.now);
    expect(again.claim("n:d:x")).toBe(false);
    expect(again.claim("n:d:y")).toBe(true);
  });

  it("forgets after 5 minutes (also across a restart)", () => {
    const dir = tmpState();
    const clock = new Clock();
    const c = new ReplayCache(dir, clock.now);
    c.claim("k");
    clock.t += REPLAY_TTL_MS - 1;
    expect(c.claim("k")).toBe(false);
    clock.t += 1;
    expect(new ReplayCache(dir, clock.now).claim("k")).toBe(true);
  });

  it("log file is 0600 and compaction drops expired keys", () => {
    const dir = tmpState();
    const clock = new Clock();
    const c = new ReplayCache(dir, clock.now);
    c.claim("old");
    clock.t += REPLAY_TTL_MS + 1;
    new ReplayCache(dir, clock.now);
    expect(readFileSync(join(dir, "replay.log"), "utf8")).toBe("");
    expect(statSync(join(dir, "replay.log")).mode & 0o777).toBe(0o600);
    void c;
  });
});

describe("RateLimiter", () => {
  it("drains, refills over time, and keys are independent", () => {
    const clock = new Clock();
    const r = new RateLimiter(clock.now, 3, 1);
    expect([r.take("a"), r.take("a"), r.take("a"), r.take("a")]).toEqual([true, true, true, false]);
    expect(r.take("b")).toBe(true);
    expect(r.retryAfterS("a")).toBe(1);
    clock.t += 1000;
    expect(r.take("a")).toBe(true);
    clock.t += 60_000;
    expect([r.take("a"), r.take("a"), r.take("a"), r.take("a")]).toEqual([true, true, true, false]);
  });
});

describe("RateLimiter bounds", () => {
  it("50,000 distinct keys never exceed the hard cap", () => {
    const clock = new Clock();
    const r = new RateLimiter(clock.now, 1, 0.001, 1000);
    for (let i = 0; i < 50_000; i++) {
      r.take(`k${i}`);
      expect(r.size).toBeLessThanOrEqual(1000);
    }
  });
});
