import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { trustWorktree, withFileLock } from "../../src/tasks/trust.js";

// F-vlad-245: kilit dizininde owner.json {pid, nonce, startedAt}; yaşayan pid kırılmaz, kırma rename ile, sahibi olmayan kilit silinmez.
let dir: string;
let file: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vlad-trust-lock-"));
  file = join(dir, "claude.json");
  lock = `${file}.vlad-lock`;
});
const seed = (owner: object | null, ageMs = 0): void => {
  mkdirSync(lock);
  if (owner) writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
  const t = new Date(Date.now() - ageMs);
  utimesSync(lock, t, t);
};
const ownerOf = (): { pid: number; nonce: string; startedAt: number } => JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
const DEAD = 999_999;
const alive = (live: number[]) => (pid: number) => live.includes(pid);

describe("withFileLock owner.json", () => {
  it("writes owner.json {pid, nonce, startedAt} while held and removes the lock after", () => {
    let seen: ReturnType<typeof ownerOf> | undefined;
    const r = withFileLock(file, 100, () => { seen = ownerOf(); return "ok"; });
    expect(r).toBe("ok");
    expect(seen).toMatchObject({ pid: process.pid });
    expect(typeof seen!.nonce).toBe("string");
    expect(seen!.nonce.length).toBeGreaterThan(8);
    expect(typeof seen!.startedAt).toBe("number");
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("dead owner: broken at once even though the lock is fresh", () => {
    seed({ pid: DEAD, nonce: "n1", startedAt: Date.now() });
    const r = withFileLock(file, 100, () => "ok", { isAlive: alive([]) });
    expect(r).toBe("ok");
    expect(readdirSync(dir)).toEqual([]); // no .stale-* leftovers
  });

  it("live but slow owner (older than the stale limit): never broken, gives up at the deadline", () => {
    seed({ pid: 4242, nonce: "n1", startedAt: Date.now() - 60_000 }, 60_000);
    let ran = false;
    const r = withFileLock(file, 60, () => { ran = true; return "ok"; }, { isAlive: alive([4242]) });
    expect(r).toEqual({ locked: false });
    expect(ran).toBe(false);
    expect(ownerOf().nonce).toBe("n1");
  });

  it("PID reuse: a reused pid that looks alive keeps the lock (accepted limit: wait, not break)", () => {
    seed({ pid: 4242, nonce: "n1", startedAt: 0 }, 120_000);
    expect(withFileLock(file, 60, () => "ok", { isAlive: () => true })).toEqual({ locked: false });
  });

  it("missing owner.json, fresh dir (between mkdir and write): waits, does not break", () => {
    seed(null, 100);
    expect(withFileLock(file, 60, () => "ok", { isAlive: alive([]) })).toEqual({ locked: false });
    expect(existsSync(lock)).toBe(true);
  });

  it("missing owner.json, dir older than the stale limit: broken", () => {
    seed(null, 20_000);
    expect(withFileLock(file, 100, () => "ok")).toBe("ok");
  });

  it("unreadable owner.json counts as missing", () => {
    seed(null, 20_000);
    writeFileSync(join(lock, "owner.json"), "{broken");
    const old = new Date(Date.now() - 20_000);
    utimesSync(lock, old, old);
    expect(withFileLock(file, 100, () => "ok")).toBe("ok");
  });

  it("injected now(): stale limit is measured on it", () => {
    seed(null, 0);
    expect(withFileLock(file, 100, () => "ok", { now: () => Date.now() + 20_000 })).toBe("ok");
  });

  it("two breakers: the other one already removed the dead lock (rename fails), we still acquire", () => {
    seed({ pid: DEAD, nonce: "n1", startedAt: 0 });
    const isAlive = (): boolean => { rmSyncLock(); return false; };
    function rmSyncLock(): void { rmSync(lock, { recursive: true, force: true }); }
    expect(withFileLock(file, 100, () => "ok", { isAlive })).toBe("ok");
  });

  it("check–break race: the lock was replaced by a live owner after we judged the old one dead; the live lock survives", () => {
    seed({ pid: DEAD, nonce: "old", startedAt: 0 });
    const isAlive = (pid: number): boolean => {
      if (pid === DEAD) { // another process breaks the dead lock and takes it before our rename
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 4242, nonce: "new", startedAt: Date.now() }));
        return false;
      }
      return pid === 4242;
    };
    let ran = false;
    const r = withFileLock(file, 60, () => { ran = true; return "ok"; }, { isAlive });
    expect(r).toEqual({ locked: false });
    expect(ran).toBe(false);
    expect(ownerOf().nonce).toBe("new");
  });

  it("finally never deletes a lock another process owns now", () => {
    withFileLock(file, 100, () => { // our lock got broken and re-acquired by someone else while we ran
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 4242, nonce: "other", startedAt: Date.now() }));
    });
    expect(ownerOf().nonce).toBe("other");
  });

  it("trustWorktree still works end to end and leaves no lock", () => {
    expect(trustWorktree("C:\\dev\\a-wt\\T1", file)).toBeNull();
    expect(readdirSync(dir)).toEqual(["claude.json"]);
  });
});
