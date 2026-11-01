import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withKbLock } from "../../src/kb/lock.js";
import { makeHome } from "../helpers.js";

let kb: string;
let lock: string;
beforeEach(() => { kb = join(makeHome(), "kb"); lock = join(kb, ".vlad.lock"); });

const deadPid = () => Number(spawnSync("node", ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
const owner = (o: object) => writeFileSync(lock, JSON.stringify({ token: "other", ...o }));
const fast = { timeoutMs: 300 };

describe("withKbLock", () => {
  it("kilidi alıp bırakır (fn hata verse de)", async () => {
    await withKbLock(() => { expect(existsSync(lock)).toBe(true); });
    expect(existsSync(lock)).toBe(false);
    await expect(withKbLock(() => { throw new Error("x"); })).rejects.toThrow("x");
    expect(existsSync(lock)).toBe(false);
  });
  it("async fn bitene kadar tutar ve sonucu döner", async () => {
    const r = await withKbLock(async () => { await new Promise((r) => setTimeout(r, 30)); expect(existsSync(lock)).toBe(true); return 7; });
    expect(r).toBe(7);
    expect(existsSync(lock)).toBe(false);
  });
  it("iç içe çağrı kendini kilitlemez (yeniden giriş)", async () => {
    const r = await withKbLock(() => withKbLock(() => "iç", fast), fast);
    expect(r).toBe("iç");
    expect(existsSync(lock)).toBe(false);
  });
  it("canlı ve taze sahip varsa zaman aşımında 'kb kilidi alınamadı' der, kilide dokunmaz", async () => {
    owner({ pid: process.pid, started: Date.now() });
    await expect(withKbLock(() => 1, fast)).rejects.toThrow(/kb kilidi alınamadı/);
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("other");
  });
  it("sahip süreç ölmüşse bayat kilidi kırar", async () => {
    owner({ pid: deadPid(), started: Date.now() });
    expect(await withKbLock(() => "ok", fast)).toBe("ok");
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(kb).filter((f) => f.includes(".vlad.lock"))).toEqual([]);
  });
  it("sahip canlı ama kilit staleMs'den eskiyse kırar", async () => {
    owner({ pid: process.pid, started: Date.now() - 3_600_000 });
    expect(await withKbLock(() => "ok", { ...fast, staleMs: 60_000 })).toBe("ok");
  });
  it("okunamayan kilit dosyası mtime'a göre değerlendirilir (taze: bekler, eski: kırar)", async () => {
    writeFileSync(lock, "çöp");
    await expect(withKbLock(() => 1, fast)).rejects.toThrow(/kb kilidi alınamadı/);
    expect(await withKbLock(() => "ok", { ...fast, staleMs: 0 })).toBe("ok");
  });
  it("bırakırken başkasının kilidini silmez", async () => {
    await withKbLock(() => { owner({ pid: process.pid, started: Date.now() }); });
    expect(existsSync(lock)).toBe(true);
  });
  it("kb klasörü yoksa kilitsiz çalışır, klasör yaratmaz", async () => {
    rmSync(kb, { recursive: true }); // temp home'un kb'si (makeHome)
    expect(await withKbLock(() => "ok", fast)).toBe("ok");
    expect(existsSync(kb)).toBe(false);
  });
});
