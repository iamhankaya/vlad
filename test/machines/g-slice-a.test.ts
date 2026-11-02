import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../../src/agent/journal.js";
import { installPlan } from "../../src/agent/install.js";
import { mergeVerdict } from "../../src/agent/ops/merge-reconcile.js";
import { setAgentEnv } from "../../src/agent/ops/env.js";
import { OP_TABLE, type OpHandler } from "../../src/agent/ops/index.js";
import { opStatus } from "../../src/agent/ops/op-status.js";
import { AgentQueue } from "../../src/agent/queue.js";
import { handleRequest, type ServerOpts } from "../../src/agent/server.js";
import { signRequest } from "../../src/agent/sign.js";
import { ensurePrivateDir, lockDownFile, writeLocal } from "../../src/agent/state.js";
import { defaultConfig } from "../../src/kb/config.js";
import type { AgentOp, AgentRequest } from "../../src/machines/types.js";
import { rmTemp } from "../helpers.js";

// Bulgu temizliği, dilim A (T20261102-07): Agent depolama/protokol. Dosya sistemi çağrıları geçiş-yapan sarmalayıcıyla gözlenir.
vi.mock("node:fs", async (orig) => {
  const a = await orig<typeof import("node:fs")>();
  return { ...a, mkdirSync: vi.fn(a.mkdirSync), chmodSync: vi.fn(a.chmodSync), readFileSync: vi.fn(a.readFileSync) };
});

const real = await vi.importActual<typeof import("node:fs")>("node:fs");
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-ga-")); dirs.push(d); return d; };
afterEach(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
  vi.mocked(fs.readFileSync).mockImplementation(real.readFileSync);
  vi.mocked(fs.mkdirSync).mockClear();
  vi.mocked(fs.chmodSync).mockClear();
});

const K = { mac: "11".repeat(32), windows: "22".repeat(32) };
const cfg = () => ({ ...defaultConfig(), brain: "mac", machines: [{ name: "mac", os: "darwin" as const, agent: { host: "127.0.0.1", port: 1 } }, { name: "windows", os: "win32" as const, agent: { host: "127.0.0.1", port: 1 } }] });
const serverOpts = (journal: Journal, ops: Partial<Record<AgentOp, OpHandler>>): ServerOpts => ({
  self: "windows", kind: "worker-agent", cfg, keys: K, ops: { ...OP_TABLE, ...ops }, journal, build: "t", bind: "127.0.0.1", port: 0,
});
const req = (o: Partial<AgentRequest>): AgentRequest => signRequest(K.mac, { v: 1, from: "mac", to: "windows", opId: "op-1", ts: Date.now(), op: "ping", args: {}, ...o });
const ebusy = () => Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });

describe("F-vlad-126: yanıt sınırı bayt cinsinden", () => {
  it("çok baytlı büyük sonuç too_large olur, çerçeveye sığmayan yanıt üretilmez", async () => {
    const j = new Journal(join(tmp(), "j.jsonl"), () => Date.now());
    const big = "€".repeat(3_000_000); // 3M karakter ama ~9 MB bayt
    const r = await handleRequest(serverOpts(j, { ping: async () => ({ big }) as never }), req({ opId: "big-1" }));
    expect(r.code).toBe("too_large");
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(8 * 1024 * 1024);
  });
});

describe("F-vlad-127: günlük sonucu kırpılır", () => {
  it("64 KiB'ı aşan sonuç günlükte işaretli küçük kayıt olur; küçük sonuç aynen kalır", () => {
    const f = join(tmp(), "j.jsonl");
    const j = new Journal(f, () => Date.now());
    j.start("big", "mac", "exec", "h"); j.finish("big", "done", { stdout: "x".repeat(3 * 1024 * 1024) });
    j.start("small", "mac", "exec", "h"); j.finish("small", "done", { stdout: "ok" });
    const again = new Journal(f, () => Date.now());
    expect(again.get("small")?.result).toEqual({ stdout: "ok" });
    expect(again.get("big")?.result).toMatchObject({ __journalTruncated: true });
    expect(statSync(f).size).toBeLessThan(100 * 1024);
  });
});

describe("F-vlad-152: kırpılmış sonuç sahte başarı değil; mutasyon opları küçük özet saklar", () => {
  const big = { exit: 0, stdout: "x".repeat(3 * 1024 * 1024), stderr: "" };
  it("mutasyon op'u (apply-write) büyük sonucu kırpma yerine küçük sabit özet olarak saklar; replay ok döner", async () => {
    const j = new Journal(join(tmp(), "j.jsonl"), () => Date.now());
    const o = { ...serverOpts(j, { "apply-write": async () => big as never }), self: "mac", kind: "brain-agent" as const }; // apply-write: işçi → beyin
    const rq = (opId: string) => signRequest(K.windows, { v: 1, from: "windows", to: "mac", opId, ts: Date.now(), op: "apply-write", args: w });
    const w = { cmd: "task.log", id: "T20261102-01", text: "x" };
    const live = await handleRequest(o, rq("aw-1"));
    expect(live.code).toBe("ok");
    const rec = j.get("aw-1")?.result as Record<string, unknown>;
    expect(rec).toMatchObject({ __journalSummary: true, exit: 0 });
    expect(JSON.stringify(rec).length).toBeLessThan(2048);
    const replay = await handleRequest(o, rq("aw-1"));
    expect(replay.code).toBe("ok");
    expect((replay as { result?: unknown }).result).toMatchObject({ __journalSummary: true, exit: 0 });
  });
  it("mutasyon olmayan op kırpılırsa op-status state:done + truncated:true döner, işaret nesnesini sonuç diye vermez", async () => {
    const j = new Journal(join(tmp(), "j.jsonl"), () => Date.now());
    j.start("cl-1", "mac", "close", "h"); j.finish("cl-1", "done", big);
    setAgentEnv({ self: "windows", kind: "worker-agent", cfg: cfg(), startedAt: Date.now(), build: "t", journal: j, now: () => Date.now() } as never);
    try {
      const r = await opStatus({ target: "cl-1" }, { from: "mac" });
      expect(r).toMatchObject({ state: "done", truncated: true });
      expect(r.result).toBeUndefined();
    } finally { setAgentEnv(undefined); }
  });
  it("eski kırpılmış launch kaydının too_large mesajı 'yeni opId ile çalıştır' demez (mutasyon çift uygulanır)", async () => {
    const f = join(tmp(), "j.jsonl");
    writeFileSync(f, JSON.stringify({ opId: "ln-1", from: "mac", op: "launch", state: "done", ts: Date.now(), argsHash: "", result: { __journalTruncated: true, bytes: 9 } }) + "\n");
    const r = await handleRequest(serverOpts(new Journal(f, () => Date.now()), {}), req({ op: "launch", opId: "ln-1", args: {} }));
    expect(r.code).toBe("too_large");
    expect(JSON.stringify(r)).not.toContain("yeni opId");
  });
});

describe("F-vlad-155: açılışta okunamayan inflight girdi sonradan pending'e döner", () => {
  it("EBUSY ile okunamayan inflight girdi drain öncesi yeniden denenip gönderilir (kuyruk takılmaz)", async () => {
    const d = tmp();
    const q1 = new AgentQueue(d, () => 1);
    q1.enqueue({ cmd: "task.log", id: "T20261102-01", text: "a", opId: "op-a" }, "inflight"); // çökme kalıntısı
    vi.mocked(fs.readFileSync).mockImplementation(((p: fs.PathOrFileDescriptor, ...r: unknown[]) => {
      if (String(p).endsWith("-op-a.json")) throw ebusy();
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...r);
    }) as never);
    const q2 = new AgentQueue(d, () => 1); // açılışta okunamadı → pending'e çevrilemedi
    vi.mocked(fs.readFileSync).mockImplementation(real.readFileSync); // sürücü/antivirüs kilidi kalktı
    const sent: string[] = [];
    const r = await q2.flush(async (it) => { sent.push(it.opId); });
    expect(sent).toEqual(["op-a"]);
    expect(r).toMatchObject({ sent: 1, remaining: 0 });
  });
});

describe("F-vlad-128: Agent durum dizini 0700", () => {
  it("Journal ve AgentQueue dizinleri mode 0o700 ile oluşturulur", () => {
    const d = tmp();
    new Journal(join(d, "agent", "journal.jsonl"), () => 1);
    new AgentQueue(join(d, "agent", "queue"), () => 1);
    const mine = vi.mocked(fs.mkdirSync).mock.calls.filter((c) => String(c[0]).startsWith(d));
    expect(mine.length).toBeGreaterThan(0);
    for (const c of mine) expect((c[1] as { mode?: number }).mode, String(c[0])).toBe(0o700);
  });
  it("ensurePrivateDir var olan dizinin modunu da 0700'e çeker", () => {
    const d = tmp();
    ensurePrivateDir(d);
    expect(vi.mocked(fs.chmodSync)).toHaveBeenCalledWith(d, 0o700);
  });
});

describe("F-vlad-132/151: anahtar dosyası Windows'ta ACL ile özel", () => {
  const SID = "S-1-5-21-1-2-3-1001";
  const exec = (calls: { file: string; args: string[] }[]) => (file: string, args: string[]): string => {
    calls.push({ file, args });
    return file.endsWith("whoami.exe") ? `"PC\\me","${SID}"\r\n` : "";
  };
  it("win32: tam yollu icacls mirası keser ve yalnız geçerli kullanıcıya SID ile tam yetki verir", () => {
    const calls: { file: string; args: string[] }[] = [];
    lockDownFile("C:\\v\\vlad.local.json", { platform: "win32", systemRoot: "C:\\Windows", exec: exec(calls) });
    expect(calls.at(-1)).toEqual({ file: "C:\\Windows\\System32\\icacls.exe", args: ["C:\\v\\vlad.local.json", "/inheritance:r", "/grant:r", `*${SID}:F`] });
  });
  it("win32'de icacls başarısızlığı yazmayı düşürmez ama görünür uyarı verir (fail-open sessiz değil)", () => {
    const warns: string[] = [];
    expect(() => lockDownFile("x", { platform: "win32", systemRoot: "C:\\Windows", warn: (m) => warns.push(m), exec: (f) => { if (f.endsWith("icacls.exe")) throw new Error("yok"); return `"a","${SID}"`; } })).not.toThrow();
    expect(warns.join("\n")).toMatch(/kısıtlanamadı[\s\S]*yok/);
  });
  it("kullanıcı SID'i alınamazsa icacls çağrılmaz, uyarı verilir", () => {
    const warns: string[] = [];
    const calls: string[] = [];
    lockDownFile("x", { platform: "win32", systemRoot: "C:\\Windows", warn: (m) => warns.push(m), exec: (f) => { calls.push(f); return "çöp"; } });
    expect(calls.some((c) => c.endsWith("icacls.exe"))).toBe(false);
    expect(warns).toHaveLength(1);
  });
  it("writeLocal: dosya içerik yazılmadan ÖNCE (boşken) kilitlenir", () => {
    const f = join(tmp(), "vlad.local.json");
    process.env.VLAD_LOCAL_FILE = f;
    let atLock: string | null = null;
    try { writeLocal({ keys: { a: "k" } }, { lock: (p) => { atLock = real.readFileSync(p, "utf8"); } }); } finally { delete process.env.VLAD_LOCAL_FILE; }
    expect(atLock).toBe("");
    expect(JSON.parse(real.readFileSync(f, "utf8")).keys.a).toBe("k");
  });
});

describe("F-vlad-127: kırpılmış sonuç replay'de ok gibi dönmez", () => {
  it("aynı opId tekrar gelince too_large", async () => {
    const j = new Journal(join(tmp(), "j.jsonl"), () => Date.now());
    const o = serverOpts(j, { close: async () => ({ s: "x".repeat(200_000) }) as never });
    expect((await handleRequest(o, req({ op: "close", opId: "tr-1", args: { taskId: "T" } }))).code).toBe("ok");
    expect((await handleRequest(o, req({ op: "close", opId: "tr-1", args: { taskId: "T" } }))).code).toBe("too_large");
  });
});

describe("F-vlad-135: probe-window günlüklü (replay ikinci pencere açmaz)", () => {
  it("aynı opId ikinci kez gelince işlem çalışmaz, replayed döner", async () => {
    const j = new Journal(join(tmp(), "j.jsonl"), () => Date.now());
    let n = 0;
    const o = serverOpts(j, { "probe-window": async () => { n++; return { opened: true, method: "t" } as never; } });
    const r1 = await handleRequest(o, req({ op: "probe-window", opId: "pw-1" }));
    const r2 = await handleRequest(o, req({ op: "probe-window", opId: "pw-1" }));
    expect(r1.code).toBe("ok");
    expect(r2.code).toBe("ok");
    expect(r2.meta?.replayed).toBe(true);
    expect(n).toBe(1);
  });
});

describe("F-vlad-136: kuyruk geçici okuma hatasında sağlam girdiyi failed/'e atmaz", () => {
  const item = { cmd: "task.log" as const, id: "T1", text: "a", opId: "op-a" };
  it("açılışta EBUSY: girdi kuyrukta kalır", () => {
    const d = tmp(); const q = join(d, "queue");
    new AgentQueue(q, () => 1).enqueue(item);
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown, ...r: unknown[]) => { if (String(p).endsWith("-op-a.json")) throw ebusy(); return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...r); }) as never);
    new AgentQueue(q, () => 1);
    vi.mocked(fs.readFileSync).mockImplementation(real.readFileSync);
    expect(real.readdirSync(join(q, "failed"))).toEqual([]);
    expect(new AgentQueue(q, () => 1).pending().map((i) => i.opId)).toEqual(["op-a"]);
  });
  it("boşaltırken EBUSY: gönderilmez, girdi kuyrukta kalır", async () => {
    const d = tmp(); const q = join(d, "queue");
    const queue = new AgentQueue(q, () => 1);
    queue.enqueue(item);
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown, ...r: unknown[]) => { if (String(p).endsWith("-op-a.json")) throw ebusy(); return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...r); }) as never);
    let sent = 0;
    await queue.flush(async () => { sent++; });
    vi.mocked(fs.readFileSync).mockImplementation(real.readFileSync);
    expect(sent).toBe(0);
    expect(real.readdirSync(join(q, "failed"))).toEqual([]);
    expect(queue.pending().map((i) => i.opId)).toEqual(["op-a"]);
  });
  it("gerçekten bozuk JSON hâlâ failed/'e gider", () => {
    const d = tmp(); const q = join(d, "queue");
    real.mkdirSync(q, { recursive: true });
    writeFileSync(join(q, "00000001-bad.json"), "{bozuk");
    new AgentQueue(q, () => 1);
    expect(real.readdirSync(join(q, "failed"))).toEqual(["00000001-bad.json"]);
  });
});

describe("F-vlad-141: merge uzlaştırıcısı (ata kontrolü)", () => {
  const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
  function repo(): string {
    const d = tmp();
    git(d, "init", "-q", "-b", "main");
    writeFileSync(join(d, "a.txt"), "1\n"); git(d, "add", "."); git(d, "commit", "-qm", "c1");
    git(d, "checkout", "-qb", "feat");
    writeFileSync(join(d, "a.txt"), "feat\n"); git(d, "commit", "-qam", "f1");
    git(d, "checkout", "-q", "main");
    return d;
  }
  it("birleşmemiş dal → not-applied", () => {
    expect(mergeVerdict(repo(), "feat", "main")).toBe("not-applied");
  });
  it("dal HEAD'in atası → applied (head ile)", () => {
    const d = repo();
    git(d, "merge", "--no-ff", "-qm", "m", "feat");
    expect(mergeVerdict(d, "feat", "main")).toEqual({ verdict: "applied", result: { head: git(d, "rev-parse", "HEAD").stdout.trim(), merged: true } });
  });
  it("hedef dalda değil → unknown", () => {
    expect(mergeVerdict(repo(), "feat", "baska")).toBe("unknown");
  });
  it("yarım kalmış merge (MERGE_HEAD) → unknown", () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "main\n"); git(d, "commit", "-qam", "m1");
    git(d, "merge", "feat"); // çakışır, MERGE_HEAD kalır
    expect(mergeVerdict(d, "feat", "main")).toBe("unknown");
  });
});

describe("F-vlad-146: Windows başlatma betiği", () => {
  it("çıktıyı agent.log'a yönlendirir ve VLAD_HOME'u ters eğik çizgiye normalize eder", () => {
    const w = installPlan("win32", { node: "C:\\n\\node.exe", cli: "C:\\v\\cli.js", home: "C:/Users/me/vlad", path: "" });
    expect(w.content).toContain('set "VLAD_HOME=C:\\Users\\me\\vlad"');
    expect(w.content).toContain('>> "C:\\Users\\me\\vlad\\.vlad-agent\\agent.log" 2>&1');
    expect(w.file).toBe("C:\\Users\\me\\vlad\\.vlad-agent\\agent-start.cmd");
  });
});

void readFileSync;
