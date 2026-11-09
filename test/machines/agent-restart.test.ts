import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gracefulStop, scheduleRestart, winRestartHelper } from "../../src/agent/restart.js";
import { WATCHDOG_JS } from "../../src/agent/watchdog.js";

// Agent yeniden başlatma yürütücüsü (T20261109-10, spec S23/S24): yanıt gittikten ve uçuşta op kalmadıktan sonra çıkış; Windows'ta WMI yardımcısı.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const mk = (o: Partial<Parameters<typeof scheduleRestart>[0]> = {}) => {
  const log: string[] = [];
  const d = { platform: "darwin" as NodeJS.Platform, delayMs: 2000, pollMs: 100, maxWaitMs: 5000, inflight: () => 0, stop: () => { log.push("stop"); }, helper: async () => { log.push("helper"); }, onFail: (m: string) => { log.push(`fail:${m}`); }, ...o };
  return { d, log };
};

describe("scheduleRestart", () => {
  it("Mac: gecikmeden sonra doğrulama + çıkış (stop)", async () => {
    const { d, log } = mk();
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(1900);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(log).toEqual(["helper", "stop"]);
  });
  it("uçuşta op varsa bekler; bitince çıkar", async () => {
    let n = 1;
    const { d, log } = mk({ inflight: () => n });
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log).toEqual([]);
    n = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(log).toEqual(["helper", "stop"]);
  });
  it("uçuştaki op takılırsa maxWait sonunda yine çıkar (Agent sonsuza kadar bakımda kalmaz)", async () => {
    const { d, log } = mk({ inflight: () => 1 });
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(2000 + 5100);
    expect(log).toEqual(["helper", "stop"]);
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
    expect(log).toEqual(["helper", "stop"]);
  });
  it("Mac: doğrulama (launchd yok) başarısızsa Agent çıkmaz", async () => {
    const { d, log } = mk({ helper: async () => { throw new Error("plist yok"); } });
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(2100);
    expect(log).toEqual(["fail:plist yok"]);
  });
  it("başarısız denemeden sonra aynı deps ile yeni zamanlama yeniden denenir (kalıcı sessiz yutma yok)", async () => {
    let ok = false;
    const { d, log } = mk({ helper: async () => { if (!ok) throw new Error("x"); log2.push("helper"); } });
    const log2: string[] = [];
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(2100);
    ok = true;
    scheduleRestart(d);
    await vi.advanceTimersByTimeAsync(2100);
    expect(log).toEqual(["fail:x", "stop"]);
    expect(log2).toEqual(["helper"]);
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

describe("winRestartHelper: tipografik tırnaklar (Codex P2)", () => {
  const b64 = (a: string[]) => Buffer.from(a[a.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
  it("’ ‘ ‚ ‛ PowerShell'de tırnak sayılır: ikilenir", () => {
    const ps = b64(winRestartHelper({ pidFile: "C:\\a\u2019b\\p.pid", startCmd: "C:\\a\u2018\u201A\u201Bb\\s.cmd", systemRoot: undefined }).args);
    expect(ps).toContain("'C:\\a\u2019\u2019b\\p.pid'");
    expect(ps).toContain("'C:\\a\u2018\u2018\u201A\u201A\u201B\u201Bb\\s.cmd'");
  });
  it("sağlık + geri alma: dinlemeyi bekler; açıldıysa yedekleri siler, açılmadıysa dist/node_modules'ı geri yükleyip yeniden başlatır", () => {
    const ps = b64(winRestartHelper({ pidFile: "C:\\r\\p.pid", startCmd: "C:\\r\\s.cmd", systemRoot: undefined, watch: { host: "127.0.0.1", port: 4321, repo: "C:\\r" } }).args);
    expect(ps).toContain("4321");
    expect(ps).toContain("'C:\\r\\dist-old'");
    expect(ps).toContain("'C:\\r\\node_modules-old'");
    expect(ps.indexOf("Start-Process")).toBeLessThan(ps.indexOf("TcpClient"));
    expect(ps.match(/Start-Process/g)).toHaveLength(2); // normal başlatma + geri alma sonrası başlatma
  });
});

describe("gracefulStop", () => {
  it("kapanış tamamlanırsa temizler ve çıkar", async () => {
    const log: string[] = [];
    gracefulStop({ close: async () => { log.push("close"); }, cleanup: () => log.push("cleanup"), exit: (c) => log.push(`exit${c}`), timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(50);
    expect(log).toEqual(["close", "cleanup", "exit0"]);
  });
  it("kapanış takılırsa (clip/aktarım) zaman aşımında yine temizler ve çıkar; bayrak kalıcı açık kalmaz", async () => {
    const log: string[] = [];
    gracefulStop({ close: () => new Promise(() => {}), cleanup: () => log.push("cleanup"), exit: (c) => log.push(`exit${c}`), timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(log).toEqual(["cleanup", "exit0"]);
  });
  it("iki kez çağrılırsa bir kez çıkar", async () => {
    const log: string[] = [];
    const o = { close: async () => {}, cleanup: () => {}, exit: (c: number) => log.push(`exit${c}`), timeoutMs: 1000 };
    gracefulStop(o); gracefulStop(o);
    await vi.advanceTimersByTimeAsync(2000);
    expect(log).toEqual(["exit0"]);
  });
});

describe("watchdog (gerçek süreç, gerçek soket, geçici dizin)", () => {
  beforeEach(() => vi.useRealTimers());
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const repo = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "vlad-wd-"))); dirs.push(d);
    for (const [n, c] of [["dist", "NEW"], ["dist-old", "OLD"], ["node_modules", "NEWM"], ["node_modules-old", "OLDM"]] as const) { mkdirSync(join(d, n)); writeFileSync(join(d, n, "f"), c); }
    return d;
  };
  const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
  const listen = (port: number) => new Promise<net.Server>((res) => { const s = net.createServer((c) => c.destroy()); s.listen(port, "127.0.0.1", () => res(s)); });
  const wd = (d: string, port: number, extra: Record<string, string> = {}) => new Promise<number | null>((res) => {
    const p = spawn(process.execPath, ["-e", WATCHDOG_JS], { env: { PATH: process.env.PATH ?? "", WD_HOST: "127.0.0.1", WD_PORT: String(port), WD_REPO: d, WD_WAIT_MS: "4000", ...extra }, stdio: "ignore" });
    p.on("close", (c) => res(c));
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const f = (d: string, n: string) => readFileSync(join(d, n, "f"), "utf8");

  it("yeni süreç dinlemeye başlarsa yedekler (dist-old, node_modules-old) silinir, dist aynen kalır", async () => {
    const d = repo(), port = await freePort();
    const old = await listen(port);
    const done = wd(d, port);
    await sleep(700);
    await new Promise((r) => old.close(r)); // eski Agent çıktı
    await sleep(700);
    const fresh = await listen(port); // yeni Agent açıldı
    expect(await done).toBe(0);
    await new Promise((r) => fresh.close(r));
    expect([existsSync(join(d, "dist-old")), existsSync(join(d, "node_modules-old")), f(d, "dist"), f(d, "node_modules")]).toEqual([false, false, "NEW", "NEWM"]);
  }, 20_000);
  it("yeni süreç hiç dinlemezse dist ve node_modules yedekten geri yüklenir; geri alma komutu çalışır", async () => {
    const d = repo(), port = await freePort();
    const old = await listen(port);
    const kick = join(d, "kicked");
    const done = wd(d, port, { WD_WAIT_MS: "2500", WD_KICK: JSON.stringify([process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(kick)},'1')`]) });
    await sleep(500);
    await new Promise((r) => old.close(r)); // eski çıktı, yenisi açılmıyor
    expect(await done).toBe(0);
    expect([f(d, "dist"), f(d, "node_modules"), existsSync(join(d, "dist-old")), existsSync(kick)]).toEqual(["OLD", "OLDM", false, true]);
  }, 20_000);
  it("eski süreç hiç çıkmazsa dokunmaz (yedekler yerinde)", async () => {
    const d = repo(), port = await freePort();
    const old = await listen(port);
    expect(await wd(d, port, { WD_WAIT_MS: "1200" })).toBe(0);
    await new Promise((r) => old.close(r));
    expect([f(d, "dist"), existsSync(join(d, "dist-old"))]).toEqual(["NEW", true]);
  }, 20_000);
  const child = () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  it("WD_PID: yeni süreç eski pid çıkmadan porta oturmuş olsa bile (port hiç kapanmadı) eski pid ölünce yedekler silinir (Codex P2)", async () => {
    const d = repo(), port = await freePort();
    const oldAgent = child();
    const fresh = await listen(port); // launchd yenisini hızla açtı: port 'kapandı' görülmedi
    const done = wd(d, port, { WD_PID: String(oldAgent.pid) });
    await sleep(700);
    oldAgent.kill("SIGKILL");
    expect(await done).toBe(0);
    await new Promise((r) => fresh.close(r));
    expect([existsSync(join(d, "dist-old")), existsSync(join(d, "node_modules-old")), f(d, "dist")]).toEqual([false, false, "NEW"]);
  }, 20_000);
  it("WD_PID: eski pid yaşıyorsa dokunmaz", async () => {
    const d = repo(), port = await freePort();
    const oldAgent = child();
    const fresh = await listen(port);
    expect(await wd(d, port, { WD_PID: String(oldAgent.pid), WD_WAIT_MS: "1200" })).toBe(0);
    oldAgent.kill("SIGKILL"); await new Promise((r) => fresh.close(r));
    expect([f(d, "dist"), existsSync(join(d, "dist-old"))]).toEqual(["NEW", true]);
  }, 20_000);
  it("WD_PID: eski pid öldü, yeni hiç dinlemiyor → geri yükleme", async () => {
    const d = repo(), port = await freePort();
    const oldAgent = child();
    const done = wd(d, port, { WD_PID: String(oldAgent.pid), WD_WAIT_MS: "2000" });
    await sleep(500); oldAgent.kill("SIGKILL");
    expect(await done).toBe(0);
    expect([f(d, "dist"), f(d, "node_modules")]).toEqual(["OLD", "OLDM"]);
  }, 20_000);
});
