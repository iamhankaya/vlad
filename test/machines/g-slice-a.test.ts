import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../../src/agent/journal.js";
import { installPlan } from "../../src/agent/install.js";
import { mergeVerdict } from "../../src/agent/ops/merge-reconcile.js";
import { OP_TABLE, type OpHandler } from "../../src/agent/ops/index.js";
import { AgentQueue } from "../../src/agent/queue.js";
import { handleRequest, type ServerOpts } from "../../src/agent/server.js";
import { signRequest } from "../../src/agent/sign.js";
import { ensurePrivateDir, lockDownFile } from "../../src/agent/state.js";
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

describe("F-vlad-132: anahtar dosyası Windows'ta ACL ile özel", () => {
  it("win32: icacls mirası keser ve yalnız geçerli kullanıcıya tam yetki verir", () => {
    const calls: { file: string; args: string[] }[] = [];
    lockDownFile("C:\\v\\vlad.local.json", { platform: "win32", user: "PC\\me", exec: (file, args) => { calls.push({ file, args }); } });
    expect(calls).toEqual([{ file: "icacls", args: ["C:\\v\\vlad.local.json", "/inheritance:r", "/grant:r", "PC\\me:F"] }]);
  });
  it("win32'de icacls başarısızlığı yazmayı düşürmez", () => {
    expect(() => lockDownFile("x", { platform: "win32", user: "u", exec: () => { throw new Error("yok"); } })).not.toThrow();
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
