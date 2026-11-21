import { describe, expect, it } from "vitest";
import { listenWithRetry } from "../../src/agent/listen-retry.js";
import { execTimeoutFor } from "../../src/approver/exec.js";
import { LIMITS } from "../../src/approver/types.js";

const err = (code: string) => Object.assign(new Error(code), { code });

// T20261121-31 doğrulama (F-vlad-358 / F-vlad-360). iptal-uyku testi düzeltmeyle `it.fails` → `it` oldu.
describe("doğrulama: listenWithRetry gerçek uyku", () => {
  it("normal yol: gerçek zamanlayıcıyla (küçük baseMs) başarır", async () => {
    let n = 0;
    const r = await listenWithRetry(async () => { if (++n < 3) throw err("EADDRNOTAVAIL"); return "ok"; }, { log: () => {}, baseMs: 5, maxMs: 10 });
    expect(r).toBe("ok");
  });
  it("hata başka koda dönerse yeniden denemede de beklemeden fırlar", async () => {
    let n = 0;
    await expect(listenWithRetry(async () => { if (++n === 1) throw err("EADDRNOTAVAIL"); throw err("EADDRINUSE"); }, { sleep: async () => {}, log: () => {} })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
  it("sinyal önceden iptalse ilk hatada beklemeden fırlar", async () => {
    const ac = new AbortController(); ac.abort();
    await expect(listenWithRetry(async () => { throw err("EADDRNOTAVAIL"); }, { sleep: async () => { throw new Error("uyumamalı"); }, log: () => {}, signal: ac.signal })).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
  });
  // SIGTERM işleyicisi varsayılan çıkışı kapatır (start.ts); iptal uykuyu kesmezse <= 60 sn gecikir (launchd SIGKILL'e düşer).
  it("[F-vlad-358] iptal uykuyu keser: bekleme sırasında iptal hemen döner", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = listenWithRetry(async () => { throw err("EADDRNOTAVAIL"); }, { log: () => {}, baseMs: 3000, maxMs: 3000, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
    expect(Date.now() - t0).toBeLessThan(1500);
  }, 10_000);
});

describe("doğrulama: execTimeoutFor argv biçimleri", () => {
  it("bayraklı uzun komut da manifest süresini alır", () => {
    expect(execTimeoutFor(["task", "gate", "T1", "--json"])).toBe(31 * 60_000);
  });
  it("hiçbir komut taban değerin altına düşürmez", () => {
    for (const a of [[], ["status"], ["task"], ["kb", "search", "x"], ["task", "gate", "T1"]]) expect(execTimeoutFor(a)).toBeGreaterThanOrEqual(LIMITS.execTimeoutMs);
  });
});
