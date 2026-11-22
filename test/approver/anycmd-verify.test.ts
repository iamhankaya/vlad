import { chmodSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApproverChannel, WatchHandlers } from "../../src/approver/ntfy.js";
import { approveTag, computeDigest, denyTag, keyGen, type RandomSource } from "../../src/approver/request.js";
import { runApprover, type ApproverDeps } from "../../src/approver/service.js";
import { createStore, type Store } from "../../src/approver/store.js";
import { LIMITS, type AckRecord, type PendingRecord, type RateState, type ResultRecord } from "../../src/approver/types.js";
import { approverDir, initKey, readKey, setSecretDirForTests } from "../../src/mode/token.js";
import { secretHits } from "../support/approver-secrets.js";

// approver: telefon onayı tüm komutlar, doğrulama fazı (T20261120-23). Servis harness'i service.test.ts ile aynı kalıp.
// (eski:) service (T20261116-06 U4). Geçici gizli dizin + sahte kanal/saat/yürütücü; gerçek ~/.vlad-secret, ağ, süreç yok.
// Servis döngüsü gerçek zamanlayıcıyla yoklar (200 ms); testler yalnız "oldu mu" diye bekler, süre iddiası yok. Mantıksal zaman sahte saattir.
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const cid = (n: number) => "a".repeat(24) + B32[Math.floor(n / 32)] + B32[n % 32];
const START = Date.parse("2026-11-16T12:00:00Z");

class FakeChannel implements ApproverChannel {
  published: Array<{ p: PendingRecord; tags: { approve: string; deny: string } }> = [];
  results: ResultRecord[] = [];
  watches: Array<{ topic: string; since: number }> = [];
  h: WatchHandlers | null = null;
  failPublish = false; failWatch = false;
  async publishRequest(p: PendingRecord, tags: { approve: string; deny: string }): Promise<void> { if (this.failPublish) throw new Error("ağ yok"); this.published.push({ p, tags }); }
  watchResponse(topic: string, since: number, h: WatchHandlers, signal: AbortSignal): Promise<void> {
    if (this.failWatch) return Promise.reject(new Error("akış yok"));
    this.watches.push({ topic, since }); this.h = h;
    return new Promise((res) => signal.addEventListener("abort", () => res()));
  }
  async publishResult(r: ResultRecord): Promise<void> { this.results.push(r); }
  ready(): void { this.h!.onReady?.(); }
}

let base: string, home: string, t: number, ch: FakeChannel, store: Store, ac: AbortController, svc: Promise<void> | null, execRun: ReturnType<typeof vi.fn>, logs: string[], seq: number;
const random: RandomSource = { bytes: (n) => Buffer.alloc(n, (++seq % 250) + 1) };
const okRun = async () => ({ exitCode: 0, stdout: "tamam", stderr: "", timedOut: false });
const savedHome = process.env.VLAD_HOME;

const deps = (over: Partial<ApproverDeps> = {}): ApproverDeps => ({
  channel: ch, clock: { now: () => new Date(t) }, random, executor: { run: execRun as never }, store, log: (l) => logs.push(l), signal: ac.signal, ...over,
});
const start = (over: Partial<ApproverDeps> = {}) => { svc = runApprover(deps(over)); svc.catch(() => {}); return svc; };
const stop = async () => { ac.abort(); if (svc) await svc.catch(() => {}); svc = null; };
const waitFor = async (cond: () => unknown, what = "koşul") => { for (let i = 0; i < 250; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error(`zaman aşımı: ${what}`); };
const request = (n: number, argv: string[] = ["mode", "off"], op = "mode off") => writeFileSync(join(store.dir, "inbox", `${cid(n)}.json`), JSON.stringify({ v: 1, cid: cid(n), op, argv, requestedAt: new Date(t).toISOString(), requester: "vlad-07" }), { mode: 0o600 }); // istemci saati ≈ servis saati (F-vlad-349: ±10 dk)
const ackOf = async (n: number): Promise<AckRecord> => { const p = join(store.dir, "ack", `${cid(n)}.json`); await waitFor(() => existsSync(p), `ack ${n}`); return JSON.parse(readFileSync(p, "utf8")) as AckRecord; };
const pend = (): PendingRecord => store.readPending()!;
const body = (kind: "a1" | "d1", p: PendingRecord, key = readKey()!) => `${kind}.${p.id}.${(kind === "a1" ? approveTag : denyTag)(key, p.digest)}`;
const logText = () => (existsSync(join(store.dir, "approver.log")) ? readFileSync(join(store.dir, "approver.log"), "utf8") : "");
const resultOf = async (id: string): Promise<ResultRecord> => { await waitFor(() => store.readResult(id), "sonuç"); return store.readResult(id)!; };
/** İstek, ack, ready: pending'i döndürür. Her açılışta kanal sayaçları sıfırlanır. */
const open = async (n: number, argv?: string[], op?: string): Promise<PendingRecord> => {
  ch.h = null; ch.published.length = 0;
  request(n, argv, op);
  expect((await ackOf(n)).status).toBe("pending");
  await waitFor(() => ch.h, "abonelik");
  ch.ready();
  await waitFor(() => ch.published.length > 0, "yayın");
  return pend();
};
const rateFile = (r: RateState) => writeFileSync(join(store.dir, "rate.json"), JSON.stringify(r), { mode: 0o600 });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-svc-")));
  chmodSync(base, 0o700);
  home = join(base, "home"); process.env.VLAD_HOME = home;
  setSecretDirForTests(join(base, "s")); initKey();
  t = START; seq = 0; logs = []; svc = null; ac = new AbortController(); ch = new FakeChannel();
  store = createStore(approverDir(), { now: () => new Date(t) });
  execRun = vi.fn(okRun);
});
afterEach(async () => {
  await stop();
  setSecretDirForTests(null);
  if (savedHome === undefined) delete process.env.VLAD_HOME; else process.env.VLAD_HOME = savedHome;
  if (base.startsWith(realpathSync(tmpdir()))) rmSync(base, { recursive: true, force: true });
});


const TOKEN_RE = /^VMT2\./;

describe("telefon onayı: genel komut uçtan uca (servis + sahte yürütücü)", () => {
  it("manifest komutu: onaylanınca argv birebir, VMT2 yok, tek çalıştırma; tekrar gövde yeniden çalıştırmaz; kayıt isteyen/argv/onay zamanı/çıkış kodu", async () => {
    start();
    const argv = ["task", "list", "--json", "--limit", "3"];
    const p = await open(1, argv, "task list");
    expect(p.argv).toEqual(argv);
    t += 1000;
    ch.h!.onBody(body("a1", p));
    const r = await resultOf(p.id);
    ch.h!.onBody(body("a1", p));
    await new Promise((res) => setTimeout(res, 300));
    expect(execRun).toHaveBeenCalledTimes(1);
    const [gotArgv, token] = execRun.mock.calls[0]!;
    expect(gotArgv).toEqual(argv);
    expect(token).toBe("");
    expect(r).toMatchObject({ status: "done", exitCode: 0, op: "task list", argv, requester: expect.any(String), approvedAt: new Date(START + 1000).toISOString() });
    expect(logText()).toMatch(/çalıştırıldı: \S+ task list isteyen \S+ onay \S+ çıkış 0 \(done\)/);
  });
  it("korunan komut (monitor install): VMT2 yalnız onaylanan argv'ye bağlı verilir; genel komutta env'e token girmez", async () => {
    start();
    const p = await open(1, ["monitor", "install", "--server", "x"], "monitor install");
    ch.h!.onBody(body("a1", p));
    await resultOf(p.id);
    expect(execRun.mock.calls[0]![1]).toMatch(TOKEN_RE);
  });
  it("onaydan sonra yürütülmeyen sonuç (ctx_changed) 'çalıştırıldı' diye kaydedilmemeli (F-vlad-359)", async () => {
    start();
    const p = await open(1, ["task", "list"], "task list");
    const other = join(base, "other-home"); mkdirSync(other, { recursive: true });
    process.env.VLAD_HOME = other; // onay ile yürütme arasında bağlam değişir
    ch.h!.onBody(body("a1", p));
    const r = await resultOf(p.id);
    expect(r).toMatchObject({ status: "denied", reason: "ctx_changed" });
    expect(execRun).not.toHaveBeenCalled();
    expect(logText()).not.toMatch(/çalıştırıldı:/);
    expect(logText()).toMatch(/onaylandı, çalıştırılmadı: \S+ task list .*\(denied: ctx_changed\) argv task list/);
  });
});

// --- istek doğrulama / bildirim (saf fonksiyonlar) ---
import { COMMANDS } from "../../src/commands/manifest.js";
import { opOfArgv, renderNotification, validateRequest } from "../../src/approver/request.js";
import { requestApproval } from "../../src/cli/groups/approver.js";

const CID = "a".repeat(26);
const mkReq = (argv: string[], op: string) => ({ v: 1, cid: CID, op, argv, requestedAt: new Date().toISOString(), requester: "vlad-07" });
const rej = (argv: string[], op: string) => { const r = validateRequest(mkReq(argv, op)); return r.ok ? "ok" : r.reason; };
const pendingOf = (argv: string[], op: string): PendingRecord => ({
  v: 1, id: "mfrggzdfmztwq2lknnwg23tpoa", shortId: "mfrggzdf", cid: CID, op, argv, requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3e5).toISOString(),
  nonce: "0".repeat(32), respTopic: "vlad-r-" + "a".repeat(26), digest: "0".repeat(64), ctx: { home: "/h", kb: "/k", cli: "/c" }, keyGen: "0".repeat(16), status: "pending", requester: "vlad-07",
});

describe("telefon onayı: istek doğrulama saldırı girdileri", () => {
  it("engelli bir yolu sarmalayan/gizleyen argv biçimleri reddedilir (büyük harf, önüne bayrak/boşluk, op uyuşmazlığı, ek-token)", () => {
    for (const [argv, op] of [
      [["Task", "close", "T1"], "Task close"], [["task", "--json", "close", "T20261120-01"], "task"], [[" task", "close"], " task close"],
      [["task", "close", "T20261120-01"], "task list"], [["task", "list"], "task close"], [["mode", "request", "night"], "mode request"],
      [["mode", "request", "mode", "request", "night"], "mode"], [["approver", "run"], "approver"], [["--version"], "--version"], [["help", "mode"], "help"], [["task"], "task"], [[], ""],
    ] as Array<[string[], string]>) expect(rej(argv, op), JSON.stringify(argv)).not.toBe("ok");
  });
  it("engelli yolun ardına gelen izinli yol öneki aldatmacası: mode request <engelli-olmayan komut> reddedilir (kendini isteyen istek)", () => {
    expect(rej(["mode", "request", "task", "list"], "mode request")).toBe("not_allowlisted");
    expect(rej(["approver", "run", "status"], "approver run")).toBe("not_allowlisted");
  });
  it("istemci (opOfArgv) ile servis doğrulaması her manifest yolunda aynı op'u üretir", () => {
    for (const s of COMMANDS) {
      const argv = [...s.path, "x"];
      expect(opOfArgv(argv), s.path.join(" ")).toBe(s.path.join(" ")); // en uzun yol; fazladan pozisyonel yol üyesi sayılmaz
    }
  });
  it("kontrol/bidi/sıfır genişlik karakteri komut yolunda ve argümanda reddedilir", () => {
    for (const bad of ["‮", "​", "\u0000", " ", " "]) {
      expect(rej(["task", "list", "a" + bad + "b"], "task list"), JSON.stringify(bad)).toBe("control_char");
      expect(rej(["task" + bad, "list"], "task" + bad + " list")).not.toBe("ok");
    }
  });
});

describe("telefon onayı: bildirim argv'yi tek anlamlı gösterir", () => {
  const tokenize = (line: string): string[] => (line.replace(/^İşlem: vlad /, "").match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((t) => (t.startsWith('"') ? JSON.parse(t) : t));
  const norm = (s: string) => s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  it("tüm tehlikeli argüman biçimleri: bildirimden geri çözülen argv gerçek argv'nin aynısı; satır ASCII ve tek satır", () => {
    const nasty = ["a b", "", '"', "\\", "\\u0435", "a\\\"b", "$(id)", "`id`", ";rm -rf /", "--x=y z", "ü", "é", "е", "\u{1F600}", "%", "~", "'", "a,b", "  ", "-"];
    for (const n of nasty) {
      const argv = ["task", "log", "T20261120-01", n];
      expect(rej(argv, "task log"), JSON.stringify(n)).toBe("ok");
      const line = renderNotification(pendingOf(argv, "task log")).message.split("\n")[0]!;
      expect(line.length).toBeGreaterThan(0);
      expect(/^[\x20-\x7e]*$/.test(line.replace(/^İşlem/, "Islem")), JSON.stringify(n)).toBe(true);
      expect(tokenize(line), JSON.stringify(n)).toEqual(argv); // JSON çözümü gerçek argv'yi birebir verir (belirsizlik yok)
    }
  });
});

describe("telefon onayı: istemci tarafı", () => {
  const savedTask = process.env.VLAD_TASK_ID;
  afterEach(() => { if (savedTask === undefined) delete process.env.VLAD_TASK_ID; else process.env.VLAD_TASK_ID = savedTask; });
  it("çalışan oturumu (VLAD_TASK_ID) her komut için istek açamaz; istek dosyası yazılmaz", async () => {
    process.env.VLAD_TASK_ID = "T20261120-23";
    await expect(requestApproval("task", ["list"], {})).rejects.toThrow(/çalışan oturumu/);
    await expect(requestApproval("monitor", ["install"], {})).rejects.toThrow(/çalışan oturumu/);
    await expect(requestApproval("night", [], {})).rejects.toThrow(/çalışan oturumu/);
  });
  it("bilinmeyen komut yolu istemcide de reddedilir", async () => {
    delete process.env.VLAD_TASK_ID;
    const spy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(tmpdir())); // çalışan worktree'sinde koşan test de bağımsız kalsın (cwd koruması ayrı test)
    try { await expect(requestApproval("rm", ["-rf", "/"], {})).rejects.toThrow(/bilinmeyen komut yolu/); } finally { spy.mockRestore(); }
  });
});
