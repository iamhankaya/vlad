import { describe, expect, it } from "vitest";
import { listenWithRetry } from "../src/agent/listen-retry.js";

const err = (code: string) => Object.assign(new Error(code), { code });

// F-vlad-358: adres yokken (EADDRNOTAVAIL) çıkma/çökme döngüsü yok; geri çekilmeli yeniden deneme, aynı hata satırı tekrarlanmaz.
describe("agent: dinleme yeniden denemesi", () => {
  it("EADDRNOTAVAIL'de geri çekilmeyle bekler, sonra başarır; hata tek satır", async () => {
    let n = 0; const sleeps: number[] = []; const logs: string[] = [];
    const r = await listenWithRetry(async () => { if (++n < 5) throw err("EADDRNOTAVAIL"); return "ok"; }, { sleep: async (ms) => { sleeps.push(ms); }, log: (l) => logs.push(l), baseMs: 1000, maxMs: 4000 });
    expect(r).toBe("ok");
    expect(sleeps).toEqual([1000, 2000, 4000, 4000]);
    expect(logs).toHaveLength(1);
  });
  it("başka hata (EADDRINUSE) beklemeden fırlatılır", async () => {
    await expect(listenWithRetry(async () => { throw err("EADDRINUSE"); }, { sleep: async () => { throw new Error("uyumamalı"); }, log: () => {} })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
  it("durdurma sinyali bekleyen denemeyi bırakır", async () => {
    const ac = new AbortController();
    const p = listenWithRetry(async () => { throw err("EADDRNOTAVAIL"); }, { sleep: async () => { ac.abort(); }, log: () => {}, signal: ac.signal });
    await expect(p).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
  });
});
