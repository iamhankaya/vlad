import { describe, expect, it } from "vitest";
import { agentStop, type StopDeps } from "../src/agent/stop.js";

// `vlad agent stop`: gerçek launchctl/schtasks ÇAĞRILMAZ; hepsi sahte `run` ile (launchd-guard ilkesi).
type Call = { file: string; args: string[] };

function mk(o: { platform: NodeJS.Platform; alive?: boolean[]; run?: (c: Call) => { code: number; stdout?: string; stderr?: string }; pid?: number | null; pidAlive?: boolean; pidAliveSeq?: boolean[] }) {
  const calls: Call[] = []; const killed: number[] = [];
  const alive = [...(o.alive ?? [true, false])];
  let ended = false; const pidSeq = o.pidAliveSeq ? [...o.pidAliveSeq] : null;
  const d: StopDeps = {
    platform: o.platform, uid: 501,
    run: async (file, args) => { const c = { file, args }; calls.push(c); if (args[0] === "bootout" || args[0] === "/End") ended = true; const r = o.run?.(c) ?? { code: 0 }; return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; },
    probe: async () => (alive.length > 1 ? alive.shift()! : alive[0]!),
    readPid: () => (o.pid === undefined ? null : o.pid),
    isAlive: () => (pidSeq ? (pidSeq.length > 1 ? pidSeq.shift()! : pidSeq[0]!) : (o.pidAlive ?? !ended)),
    kill: (pid) => { killed.push(pid); ended = true; },
    sleep: async () => {}, waitMs: 30, pollMs: 5,
  };
  return { d, calls, killed };
}

describe("agent stop: Mac (launchd)", () => {
  it("launchd'de yüklüyse bootout çalıştırır; SIGTERM göndermez (KeepAlive yeniden başlatırdı)", async () => {
    const { d, calls, killed } = mk({ platform: "darwin", pid: 4242 });
    const r = await agentStop(d);
    expect(calls.map((c) => c.args[0])).toEqual(["print", "bootout"]);
    expect(calls[1]).toEqual({ file: "launchctl", args: ["bootout", "gui/501/com.vlad.agent"] });
    expect(killed).toEqual([]);
    expect(r).toMatchObject({ stopped: true, method: "launchd-bootout", wasRunning: true });
    expect(r.note).toMatch(/KeepAlive/);
    expect(r.note).toMatch(/geçici/); // kalıcılık açık yazılı
    expect(r.note).toMatch(/oturum açılışında/);
  });
  it("launchd'de kayıtlı değilse (elle başlatılmış) pid dosyasındaki sürece sinyal gönderir", async () => {
    const { d, calls, killed } = mk({ platform: "darwin", pid: 4242, run: (c) => (c.args[0] === "print" ? { code: 113, stderr: "Could not find service" } : { code: 0 }) });
    const r = await agentStop(d);
    expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    expect(killed).toEqual([4242]);
    expect(r.method).toBe("signal");
  });
  it("bootout hata verirse (servis var ama çıkarılamadı) açık hata fırlatır", async () => {
    const { d } = mk({ platform: "darwin", run: (c) => (c.args[0] === "bootout" ? { code: 5, stderr: "Input/output error" } : { code: 0 }) });
    await expect(agentStop(d)).rejects.toThrow(/bootout.*Input\/output error/);
  });
});

describe("agent stop: Windows (zamanlanmış görev)", () => {
  it("schtasks /End /TN VladAgent çalıştırır; görev silinmez, kalıcılık açık yazılı", async () => {
    const { d, calls } = mk({ platform: "win32" });
    const r = await agentStop(d);
    expect(calls).toEqual([{ file: "schtasks", args: ["/End", "/TN", "VladAgent"] }]);
    expect(r).toMatchObject({ stopped: true, method: "schtasks-end" });
    expect(r.note).toMatch(/oturum açılışında/);
    expect(r.note).toMatch(/\/DISABLE/);
  });
  it("görev çalışmıyorsa (schtasks hata) pid dosyasındaki süreci sonlandırır", async () => {
    const { d, killed } = mk({ platform: "win32", pid: 777, run: () => ({ code: 1, stderr: "ERROR: The specified task name does not exist" }) });
    const r = await agentStop(d);
    expect(killed).toEqual([777]);
    expect(r.method).toBe("signal");
  });
});

describe("agent stop: ortak", () => {
  it("Agent zaten çalışmıyorsa hiçbir şey çalıştırmaz", async () => {
    // ping yok + servis kayıtlı değil + süreç yok: yalnız salt okunur sorgu (print), durdurucu fiil yok
    const { d, calls, killed } = mk({ platform: "darwin", alive: [false], pid: null, run: () => ({ code: 113, stderr: "Could not find service" }) });
    expect(await agentStop(d)).toMatchObject({ stopped: true, method: "none", wasRunning: false });
    expect(calls.map((c) => c.args[0])).toEqual(["print"]); expect(killed).toEqual([]);
  });
  it("durdurma sonrası Agent hâlâ yanıt veriyorsa hata verir (sessiz başarı yok)", async () => {
    const { d } = mk({ platform: "win32", alive: [true] });
    await expect(agentStop(d)).rejects.toThrow(/durmadı/);
  });
  it("pid dosyası yok ve launchd/schtasks yolu da yoksa neden açık hata", async () => {
    const { d } = mk({ platform: "darwin", pid: null, alive: [true], run: () => ({ code: 113 }) });
    await expect(agentStop(d)).rejects.toThrow(/durdurulacak süreç bulunamadı/);
  });
});

// Codex P1 (T20261121-49): ping cevapsız (ör. listenWithRetry adres bekliyor) ama süreç/servis canlı.
describe("agent stop: ping'den bağımsız durum denetimi", () => {
  it("Mac: ping yok ama launchd işi canlı (pid var) → bootout çalışır, süreç bitişi doğrulanır", async () => {
    const { d, calls } = mk({ platform: "darwin", alive: [false], pid: 4242, pidAliveSeq: [true, true, false], run: (c) => (c.args[0] === "print" ? { code: 0, stdout: "state = running\n pid = 4242" } : { code: 0 }) });
    const r = await agentStop(d);
    expect(calls.map((c) => c.args[0])).toEqual(["print", "bootout"]);
    expect(r).toMatchObject({ stopped: true, wasRunning: true, method: "launchd-bootout" });
  });
  it("Mac: ping yok, servis kayıtsız, pid dosyasındaki süreç canlı → sinyal gönderir", async () => {
    const { d, killed } = mk({ platform: "darwin", alive: [false], pid: 4242, pidAliveSeq: [true, false], run: () => ({ code: 113, stderr: "Could not find service" }) });
    const r = await agentStop(d);
    expect(killed).toEqual([4242]);
    expect(r).toMatchObject({ method: "signal", wasRunning: true });
  });
  it("Windows: ping yok ama zamanlanmış görev çalışıyor (/End başarılı) → schtasks-end", async () => {
    const { d, calls } = mk({ platform: "win32", alive: [false], pid: 777, pidAliveSeq: [true, false] });
    const r = await agentStop(d);
    expect(calls).toEqual([{ file: "schtasks", args: ["/End", "/TN", "VladAgent"] }]);
    expect(r).toMatchObject({ stopped: true, wasRunning: true, method: "schtasks-end" });
  });
  it("Windows: ping yok, görev çalışmıyor, süreç yok → zaten çalışmıyor", async () => {
    const { d, killed } = mk({ platform: "win32", alive: [false], pid: null, run: () => ({ code: 1, stderr: "ERROR: There is no running instance" }) });
    expect(await agentStop(d)).toMatchObject({ method: "none", wasRunning: false });
    expect(killed).toEqual([]);
  });
  it("durdurma sonrası ping yok ama süreç hâlâ canlıysa hata (ping kaybı yetmez)", async () => {
    const { d } = mk({ platform: "darwin", alive: [false], pid: 4242, pidAliveSeq: [true], run: (c) => (c.args[0] === "print" ? { code: 0, stdout: "pid = 4242" } : { code: 0 }) });
    await expect(agentStop(d)).rejects.toThrow(/süreç.*4242|4242.*süreç/);
  });
  it("Mac: launchd'de yüklü ama çalışmıyor (ping yok, süreç yok, pid satırı yok) → dokunmaz", async () => {
    const { d, calls } = mk({ platform: "darwin", alive: [false], pid: null, run: () => ({ code: 0, stdout: "state = waiting" }) });
    expect(await agentStop(d)).toMatchObject({ method: "none", wasRunning: false });
    expect(calls.map((c) => c.args[0])).toEqual(["print"]);
  });
});
