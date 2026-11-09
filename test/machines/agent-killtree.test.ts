import { describe, expect, it } from "vitest";
import { killTreeWait, type KillDeps } from "../../src/agent/proc.js";

// T20261109-11 (F-vlad-270): zaman aşımında süreç ağacının GERÇEKTEN bittiği beklenir; doğrulanamazsa false döner.
// Sahte taskkill/pid: gerçek süreç öldürülmez.
const fakeProc = (pid: number | undefined) => ({ pid, kill: () => true }) as unknown as Parameters<typeof killTreeWait>[0];
function world(o: { platform: NodeJS.Platform; taskkillCode?: number | null; diesAfterMs?: number; taskkillDelayMs?: number }) {
  let now = 0, killedAt: number | null = null;
  const calls: string[] = [];
  const deps: KillDeps = {
    platform: o.platform,
    spawnTaskkill: async (pid) => { calls.push(`taskkill:${pid}`); now += o.taskkillDelayMs ?? 0; killedAt = now; return o.taskkillCode === undefined ? 0 : o.taskkillCode; },
    signalGroup: (pid) => { calls.push(`sigkill:${pid}`); killedAt = now; },
    isAlive: (pid) => { calls.push(`alive?:${pid}`); return killedAt === null || o.diesAfterMs === undefined ? o.diesAfterMs === undefined ? true : false : now - killedAt < o.diesAfterMs; },
    sleep: async (ms) => { now += ms; },
  };
  return { deps, calls };
}

describe("killTreeWait (F-vlad-270)", () => {
  it("Windows: taskkill çıkışı 0 ve kök pid ölünce true; taskkill beklenir (taskkill bitmeden yoklama yok)", async () => {
    const w = world({ platform: "win32", diesAfterMs: 0 });
    expect(await killTreeWait(fakeProc(4242), { ...w.deps, waitMs: 1000 })).toBe(true);
    expect(w.calls[0]).toBe("taskkill:4242");
    expect(w.calls).toContain("alive?:4242");
  });

  it("Windows: kök pid biraz sonra ölürse sınırlı süre içinde yoklayıp true", async () => {
    const w = world({ platform: "win32", diesAfterMs: 400 });
    expect(await killTreeWait(fakeProc(7), { ...w.deps, waitMs: 2000, pollMs: 100 })).toBe(true);
  });

  it("Windows: kök pid süre dolunca hâlâ yaşıyorsa false (geri yükleme yapılmamalı)", async () => {
    const w = world({ platform: "win32" }); // asla ölmez
    expect(await killTreeWait(fakeProc(7), { ...w.deps, waitMs: 500, pollMs: 100 })).toBe(false);
  });

  it("Windows: taskkill başarısız çıkış kodu (ör. 1 erişim reddi) → kök ölmüş görünse bile false", async () => {
    const w = world({ platform: "win32", taskkillCode: 1, diesAfterMs: 0 });
    expect(await killTreeWait(fakeProc(7), { ...w.deps, waitMs: 500 })).toBe(false);
  });

  it("Windows: taskkill 128 (süreç yok, zaten bitmiş) ve kök ölü → true", async () => {
    const w = world({ platform: "win32", taskkillCode: 128, diesAfterMs: 0 });
    expect(await killTreeWait(fakeProc(7), { ...w.deps, waitMs: 500 })).toBe(true);
  });

  it("Windows: taskkill başlatılamazsa (null) false", async () => {
    const w = world({ platform: "win32", taskkillCode: null, diesAfterMs: 0 });
    expect(await killTreeWait(fakeProc(7), { ...w.deps, waitMs: 500 })).toBe(false);
  });

  it("POSIX: süreç grubuna SIGKILL, grup bitene kadar yoklanır", async () => {
    const w = world({ platform: "darwin", diesAfterMs: 300 });
    expect(await killTreeWait(fakeProc(99), { ...w.deps, waitMs: 2000, pollMs: 100 })).toBe(true);
    expect(w.calls[0]).toBe("sigkill:-99");
    expect(w.calls).toContain("alive?:-99");
  });

  it("POSIX: grup süre dolunca yaşıyorsa false", async () => {
    const w = world({ platform: "linux" });
    expect(await killTreeWait(fakeProc(99), { ...w.deps, waitMs: 400, pollMs: 100 })).toBe(false);
  });

  it("pid yoksa (hiç başlamamış) true", async () => {
    const w = world({ platform: "darwin" });
    expect(await killTreeWait(fakeProc(undefined), w.deps)).toBe(true);
  });
});
