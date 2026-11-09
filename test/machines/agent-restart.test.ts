import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleRestart, winRestartHelper } from "../../src/agent/restart.js";

// Agent yeniden başlatma yürütücüsü (T20261109-10, spec S23/S24): yanıt gittikten ve uçuşta op kalmadıktan sonra çıkış; Windows'ta WMI yardımcısı.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const mk = (o: Partial<Parameters<typeof scheduleRestart>[0]> = {}) => {
  const log: string[] = [];
  const d = { platform: "darwin" as NodeJS.Platform, delayMs: 2000, pollMs: 100, maxWaitMs: 5000, inflight: () => 0, stop: () => { log.push("stop"); }, helper: async () => { log.push("helper"); }, onFail: (m: string) => { log.push(`fail:${m}`); }, ...o };
  return { d, log };
};

describe("scheduleRestart", () => {
  it("Mac: gecikmeden sonra çıkışı (stop) çağırır, yardımcı süreç yok", async () => {
    const { d, log } = mk();
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(1900);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(log).toEqual(["stop"]);
  });
  it("uçuşta op varsa bekler; bitince çıkar", async () => {
    let n = 1;
    const { d, log } = mk({ inflight: () => n });
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log).toEqual([]);
    n = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(log).toEqual(["stop"]);
  });
  it("uçuştaki op takılırsa maxWait sonunda yine çıkar (Agent sonsuza kadar bakımda kalmaz)", async () => {
    const { d, log } = mk({ inflight: () => 1 });
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(2000 + 5100);
    expect(log).toEqual(["stop"]);
  });
  it("Windows: önce yardımcı süreç, sonra çıkış", async () => {
    const { d, log } = mk({ platform: "win32" });
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(2100);
    expect(log).toEqual(["helper", "stop"]);
  });
  it("Windows: yardımcı başlamazsa Agent ÇIKMAZ (ölü kalmasın), hata bildirilir", async () => {
    const { d, log } = mk({ platform: "win32", helper: async () => { throw new Error("wmi yok"); } });
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(2100);
    expect(log).toEqual(["fail:wmi yok"]);
  });
  it("ikinci çağrı ikinci yeniden başlatma üretmez", async () => {
    const { d, log } = mk();
    scheduleRestart(d); scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(2500);
    expect(log).toEqual(["stop"]);
  });
});

describe("winRestartHelper", () => {
  const b64 = (a: string[]) => Buffer.from(a[a.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
  it("powershell -EncodedCommand; betik pid dosyası kaybolana kadar bekler, sonra başlatma .cmd'sini açar", () => {
    const h = winRestartHelper({ pidFile: "C:\\vlad\\.vlad-agent\\agent.pid", startCmd: "C:\\vlad\\.vlad-agent\\agent-start.cmd", systemRoot: "C:\\Windows" });
    expect(h.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(h.args.slice(0, 2)).toEqual(["-NoProfile", "-NonInteractive"]);
    const ps = b64(h.args);
    expect(ps).toContain("Test-Path -LiteralPath 'C:\\vlad\\.vlad-agent\\agent.pid'");
    expect(ps).toContain("Start-Process -FilePath 'C:\\vlad\\.vlad-agent\\agent-start.cmd'");
    expect(ps.indexOf("Test-Path")).toBeLessThan(ps.indexOf("Start-Process"));
  });
  it("yollardaki tek tırnak PowerShell dizgesinde ikilenir (enjeksiyon yok)", () => {
    const h = winRestartHelper({ pidFile: "C:\\o'x\\a.pid", startCmd: "C:\\o'x\\s.cmd'; calc; '", systemRoot: undefined });
    const ps = b64(h.args);
    expect(ps).toContain("'C:\\o''x\\a.pid'");
    expect(ps).toContain("'C:\\o''x\\s.cmd''; calc; '''");
  });
});
