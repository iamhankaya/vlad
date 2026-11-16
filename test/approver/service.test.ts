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

// approver: service (T20261116-06 U4). Geçici gizli dizin + sahte kanal/saat/yürütücü; gerçek ~/.vlad-secret, ağ, süreç yok.
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

describe("approver: service onay akışı", () => {
  it("ready olmadan yayın yok; onay: VMT2 token ile tek çalıştırma, sonuç ve bildirim", async () => {
    start();
    request(1, ["mode", "off"]);
    const a = await ackOf(1);
    expect(a).toMatchObject({ cid: cid(1), status: "pending", expiresAt: new Date(START + LIMITS.approveTtlMs).toISOString() });
    const p = pend();
    expect(p).toMatchObject({ id: a.id, status: "pending", op: "mode off", argv: ["mode", "off"], respTopic: expect.stringMatching(/^vlad-r-[a-z2-7]{26}$/), shortId: a.id!.slice(0, 8) });
    expect(p.id).not.toBe(cid(1));
    await waitFor(() => ch.h, "abonelik");
    expect(ch.watches[0]!.topic).toBe(p.respTopic);
    await new Promise((r) => setTimeout(r, 300));
    expect(ch.published).toHaveLength(0); // ready yok
    ch.ready(); ch.ready();
    await waitFor(() => ch.published.length === 1, "yayın");
    await new Promise((r) => setTimeout(r, 100));
    expect(ch.published).toHaveLength(1); // yeniden hazır: tekrar yayın yok
    expect(ch.published[0]!.tags.approve).toBe(approveTag(readKey()!, p.digest));
    ch.h!.onBody(body("a1", p));
    const r = await resultOf(p.id);
    expect(r).toMatchObject({ status: "done", exitCode: 0, stdout: "tamam", op: "mode off", argv: ["mode", "off"], requester: expect.any(String) });
    expect(execRun).toHaveBeenCalledTimes(1);
    const [argv, token, ctx] = execRun.mock.calls[0]!;
    expect(argv).toEqual(["mode", "off"]);
    expect(token).toMatch(/^VMT2\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}\.[0-9a-f]{64}$/);
    expect(ctx).toEqual(p.ctx);
    expect(store.hasClaim(p.id, "decision") && store.hasClaim(p.id, "exec")).toBe(true);
    await waitFor(() => store.readPending() === null, "pending temizliği");
    await waitFor(() => ch.results.length === 1, "sonuç bildirimi");
    expect(store.readRate()).toMatchObject({ consecutiveDenied: 0, decisions: [new Date(START).toISOString()] });
  });

  it("aynı gövde aynı parçada iki kez: yalnız bir çalıştırma", async () => {
    start();
    const p = await open(1);
    ch.h!.onBody(body("a1", p)); ch.h!.onBody(body("a1", p)); ch.h!.onBody(body("d1", p));
    await resultOf(p.id);
    expect(execRun).toHaveBeenCalledTimes(1);
    expect(store.readResult(p.id)!.status).toBe("done");
  });

  it("sonuçtan sonra yanıt akışı açık kalır: tekrar oynatılan onay yürütmez ve not_pending loglanır", async () => {
    start();
    const p = await open(1);
    ch.h!.onBody(body("a1", p));
    await resultOf(p.id);
    await waitFor(() => store.readPending() === null);
    ch.h!.onBody(body("a1", p));
    expect(execRun).toHaveBeenCalledTimes(1);
    expect(logText()).toContain("not_pending");
  });

  it("durdurma: sinyali yok sayan yürütücü kapanışı sonsuza kadar tutmaz (sınırlı bekleme), kilit bırakılır", async () => {
    execRun = vi.fn(() => new Promise<never>(() => undefined)); // asla bitmez, signal'i yok sayar
    start();
    const p = await open(1);
    ch.h!.onBody(body("a1", p));
    await waitFor(() => execRun.mock.calls.length === 1);
    const t0 = Date.now();
    await stop();
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(existsSync(join(store.dir, "service.lock"))).toBe(false);
  }, 15_000);

  it("servis çalışırken pending.json bozulursa yeni istek locked, dosya üzerine yazılmaz, yayın yok", async () => {
    start();
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(store.dir, "pending.json"), '{"v":1,"id":"', { mode: 0o600 });
    request(1);
    expect(await ackOf(1)).toMatchObject({ status: "locked" });
    expect(readFileSync(join(store.dir, "pending.json"), "utf8")).toBe('{"v":1,"id":"');
    expect(ch.published).toHaveLength(0);
  });

  it("ret: çalıştırma yok, denied, ret sayacı artar", async () => {
    start();
    const p = await open(1);
    ch.h!.onBody(body("d1", p));
    expect(await resultOf(p.id)).toMatchObject({ status: "denied", reason: "reddedildi" });
    expect(execRun).not.toHaveBeenCalled();
    expect(store.readRate().consecutiveDenied).toBe(1);
  });

  it("geçersiz gövdeler etkisiz; log'a yalnız kod, neden başına 10 sn'de bir kez, gövde yok", async () => {
    start();
    const p = await open(1);
    const other = body("a1", { ...p, id: "b".repeat(26) });
    const wrongTag = `a1.${p.id}.${"0".repeat(64)}`;
    for (const b of ["çöp", other, wrongTag, wrongTag]) ch.h!.onBody(b);
    t += 11_000;
    ch.h!.onBody(wrongTag);
    const log = logText();
    expect(log).toContain("bad_format"); expect(log).toContain("unknown_id");
    expect(log.match(/bad_tag/g)).toHaveLength(2);
    expect(log).not.toContain(wrongTag); expect(log).not.toContain("çöp");
    expect(secretHits(log)).toEqual([]);
    expect(store.readPending()!.status).toBe("pending");
    expect(execRun).not.toHaveBeenCalled();
  });

  it("başka digest'in etiketi çalışmaz", async () => {
    start();
    const p = await open(1);
    ch.h!.onBody(`a1.${p.id}.${approveTag(readKey()!, "f".repeat(64))}`);
    expect(store.readPending()!.status).toBe("pending");
    expect(execRun).not.toHaveBeenCalled();
  });

  it("TTL: süre dolunca expired, sonraki onay etkisiz", async () => {
    start();
    const p = await open(1);
    t += LIMITS.approveTtlMs + 1000;
    expect(await resultOf(p.id)).toMatchObject({ status: "expired" });
    ch.h?.onBody(body("a1", p));
    expect(execRun).not.toHaveBeenCalled();
    expect(store.readRate().consecutiveDenied).toBe(1);
    expect(store.readRate().decisions).toEqual([]); // süre dolumu soğuma/kota başlatmaz
    request(2);
    expect((await ackOf(2)).status).toBe("pending"); // süresi dolan istek yenisini engellemez
  });

  it("tam sınırda gelen onay reddedilir (parseDecision expired)", async () => {
    start();
    const p = await open(1);
    t += LIMITS.approveTtlMs;
    ch.h!.onBody(body("a1", p));
    expect(execRun).not.toHaveBeenCalled();
    expect(logText()).toContain("expired");
  });
});

describe("approver: service istek kontrolleri", () => {
  it("allowlist dışı: invalid + sebep, pending yok", async () => {
    start();
    request(1, ["bash", "-c", "id"], "install");
    expect(await ackOf(1)).toMatchObject({ status: "invalid", reason: "not_allowlisted" });
    expect(store.readPending()).toBeNull();
  });

  it("bozuk JSON ve cid uyuşmazlığı: invalid", async () => {
    start();
    writeFileSync(join(store.dir, "inbox", `${cid(1)}.json`), "{bozuk", { mode: 0o600 });
    expect(await ackOf(1)).toMatchObject({ status: "invalid", reason: "bad_value" });
    writeFileSync(join(store.dir, "inbox", `${cid(2)}.json`), JSON.stringify({ v: 1, cid: cid(3), op: "mode off", argv: ["mode", "off"], requestedAt: "2026-11-16T12:00:00Z", requester: "x" }), { mode: 0o600 });
    expect(await ackOf(2)).toMatchObject({ status: "invalid", reason: "bad_value" });
  });

  it("anahtar kapalı: invalid key_disabled", async () => {
    setSecretDirForTests(join(base, "yok"));
    start();
    request(1);
    expect(await ackOf(1)).toMatchObject({ status: "invalid", reason: "key_disabled" });
  });

  it("ikinci istek busy", async () => {
    start();
    await open(1);
    request(2);
    expect(await ackOf(2)).toMatchObject({ status: "busy", id: pend().id }); // CLI "meşgul: bekleyen istek var (<shortId>)" için
  });

  it("soğuma: ret sonrası rate_limited; 3 ret locked; kilit dolunca yeniden kabul", async () => {
    start();
    for (let n = 1; n <= 3; n++) {
      const p = await open(n);
      ch.h!.onBody(body("d1", p));
      await resultOf(p.id);
      await waitFor(() => store.readPending() === null);
      request(10 + n);
      if (n < 3) { expect(await ackOf(10 + n)).toMatchObject({ status: "rate_limited" }); t += LIMITS.cooldownMs + 1; }
      else expect(await ackOf(13)).toMatchObject({ status: "locked" });
    }
    expect(store.readRate().lockedUntil).toBe(new Date(START + 2 * (LIMITS.cooldownMs + 1) + LIMITS.lockMs).toISOString());
    t += LIMITS.lockMs + 1;
    request(20);
    expect((await ackOf(20)).status).toBe("pending");
    expect(store.readRate()).toMatchObject({ consecutiveDenied: 0, lockedUntil: null });
  });

  it("saatlik 6: yedinci istek rate_limited", async () => {
    start();
    for (let n = 1; n <= 6; n++) {
      const p = await open(n);
      ch.h!.onBody(body("a1", p));
      await resultOf(p.id);
      await waitFor(() => store.readPending() === null);
      t += LIMITS.cooldownMs + 1;
    }
    request(30);
    expect(await ackOf(30)).toMatchObject({ status: "rate_limited" });
  });

  it("negatif geçen süre (saat geri alındı): soğuma sürüyor", async () => {
    rateFile({ v: 1, decisions: [new Date(START + 3_600_000).toISOString()], consecutiveDenied: 0, lockedUntil: null });
    start();
    request(1);
    expect(await ackOf(1)).toMatchObject({ status: "rate_limited" });
  });

  it("bozuk rate.json: locked rate_state_corrupt, dosya sıfırlanmaz", async () => {
    writeFileSync(join(store.dir, "rate.json"), "{kesik", { mode: 0o600 });
    start();
    request(1);
    expect(await ackOf(1)).toMatchObject({ status: "locked", reason: "rate_state_corrupt" });
    expect(readFileSync(join(store.dir, "rate.json"), "utf8")).toBe("{kesik");
  });
});

describe("approver: service ctx gerçek yol", () => {
  it("VLAD_HOME sembolik bağ olsa da ctx.home/kb gerçek yoldur (macOS /var → /private/var)", async () => {
    const real = join(base, "gercek"); mkdirSync(real, { mode: 0o700 });
    const link = join(base, "bag"); symlinkSync(real, link);
    process.env.VLAD_HOME = link;
    start();
    const p = await open(1);
    expect(p.ctx.home).toBe(realpathSync(real));
    expect(p.ctx.kb.startsWith(realpathSync(real))).toBe(true);
  });
});

describe("approver: service spawn öncesi yeniden doğrulama", () => {
  it("ctx değişti (VLAD_HOME): denied ctx_changed, spawn yok", async () => {
    start();
    const p = await open(1);
    process.env.VLAD_HOME = join(base, "baska");
    ch.h!.onBody(body("a1", p));
    expect(await resultOf(p.id)).toMatchObject({ status: "denied", reason: "ctx_changed" });
    expect(execRun).not.toHaveBeenCalled();
  });

  it("anahtar yenilendi: bekleyen istek key_changed ile reddedilir, eski onay işlemez", async () => {
    start();
    const p = await open(1);
    const old = body("a1", p);
    initKey(true);
    expect(await resultOf(p.id)).toMatchObject({ status: "denied", reason: "key_changed" });
    ch.h?.onBody(old);
    expect(execRun).not.toHaveBeenCalled();
  });

  it("pending.json 'executing' yazılamazsa spawn edilmez", async () => {
    const failing: Store = { ...store, writePending: (p) => { if (p.status === "executing") throw new Error("disk dolu"); store.writePending(p); } };
    start({ store: failing });
    const p = await open(1);
    ch.h!.onBody(body("a1", p));
    expect(await resultOf(p.id)).toMatchObject({ status: "failed" });
    expect(execRun).not.toHaveBeenCalled();
  });

  it("karar yazılamazsa (pending.json approved) spawn edilmez", async () => {
    const failing: Store = { ...store, writePending: (p) => { if (p.status === "approved") throw new Error("disk dolu"); store.writePending(p); } };
    start({ store: failing });
    const p = await open(1);
    ch.h!.onBody(body("a1", p));
    expect(await resultOf(p.id)).toMatchObject({ status: "denied" });
    expect(execRun).not.toHaveBeenCalled();
  });
});

describe("approver: service yürütme sonucu", () => {
  it("sıfırdan farklı çıkış, zaman aşımı, fırlatma: failed; çıktı 2 KB'a kırpılır", async () => {
    execRun.mockResolvedValueOnce({ exitCode: 2, stdout: "x".repeat(5000), stderr: "hata", timedOut: false });
    start();
    let p = await open(1);
    ch.h!.onBody(body("a1", p));
    let r = await resultOf(p.id);
    expect(r).toMatchObject({ status: "failed", exitCode: 2, stderr: "hata" });
    expect(r.stdout.length).toBe(2048);
    await waitFor(() => store.readPending() === null);
    t += 31_000;
    execRun.mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    p = await open(2); ch.h!.onBody(body("a1", p));
    expect(await resultOf(p.id)).toMatchObject({ status: "failed", reason: "zaman aşımı" });
    await waitFor(() => store.readPending() === null);
    t += 31_000;
    execRun.mockRejectedValueOnce(new Error("patladı"));
    p = await open(3); ch.h!.onBody(body("a1", p));
    r = await resultOf(p.id);
    expect(r.status).toBe("failed"); expect(r.reason).toContain("patladı");
  });

  it("servis durdurulursa yürütücüye iptal gider, sonuç interrupted", async () => {
    execRun.mockImplementationOnce((_a, _t, _c, d: { signal: AbortSignal }) => new Promise((res) => d.signal.addEventListener("abort", () => res({ exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: true }))));
    start();
    const p = await open(1);
    ch.h!.onBody(body("a1", p));
    await waitFor(() => execRun.mock.calls.length === 1);
    await stop();
    expect(store.readResult(p.id)).toMatchObject({ status: "interrupted", reason: "servis durduruldu" });
  });

  it("yayın hatası servisi çökertmez; istek süresi dolar", async () => {
    ch.failPublish = true;
    start();
    request(1);
    await ackOf(1);
    await waitFor(() => ch.h);
    ch.ready();
    const p = pend();
    await waitFor(() => logText().includes("istek bildirimi gönderilemedi"));
    t += LIMITS.approveTtlMs + 1;
    expect((await resultOf(p.id)).status).toBe("expired");
  });

  it("F-vlad-343: geçici yayın hatasında sınırlı geri çekilmeyle yeniden dener (tek yayın, uçuştaki ikinci yayın yok)", async () => {
    let calls = 0;
    ch.publishRequest = async (p, tags) => { calls++; if (calls < 3) throw new Error("ağ yok"); ch.published.push({ p, tags }); };
    start({ publishBackoffMs: [5, 5, 5] });
    request(1);
    await ackOf(1);
    await waitFor(() => ch.h);
    ch.ready(); ch.ready();
    await waitFor(() => ch.published.length === 1, "yeniden deneme sonrası yayın");
    await new Promise((r) => setTimeout(r, 100));
    expect(ch.published).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it("F-vlad-343: yayın hiç başarılmazsa süre dolumu art arda ret sayacına/kilide girmez", async () => {
    ch.failPublish = true;
    start({ publishBackoffMs: [5, 5] });
    request(1);
    await ackOf(1);
    await waitFor(() => ch.h);
    ch.ready();
    const p = pend();
    await waitFor(() => (logText().match(/istek bildirimi gönderilemedi/g) ?? []).length >= 3, "tüm denemeler");
    t += LIMITS.approveTtlMs + 1;
    expect((await resultOf(p.id)).status).toBe("expired");
    expect(store.readRate().consecutiveDenied).toBe(0);
  });

  it("F-vlad-353: ntfy bağlantısı hiç kurulamazsa (ready yok) 3 süre dolumu ret sayacına/kilide girmez", async () => {
    ch.failWatch = true; // onReady hiç çalışmaz
    start();
    for (let n = 1; n <= 3; n++) {
      request(n);
      expect((await ackOf(n)).status).toBe("pending");
      const p = pend();
      t += LIMITS.approveTtlMs + 1;
      expect((await resultOf(p.id)).status).toBe("expired");
      await waitFor(() => store.readPending() === null, "pending temizlendi");
    }
    expect(store.readRate().consecutiveDenied).toBe(0);
    expect(store.readRate().lockedUntil).toBeNull();
    request(4);
    expect((await ackOf(4)).status).toBe("pending"); // kilit yok
  });

  it("F-vlad-353: yayın başarılı olmuş (kullanıcıya ulaşmış) ve yanıtsız istek yine ret sayacına girer", async () => {
    start();
    const p = await open(1);
    t += LIMITS.approveTtlMs + 1;
    expect((await resultOf(p.id)).status).toBe("expired");
    expect(store.readRate().consecutiveDenied).toBe(1);
  });

  it("F-vlad-349: requestedAt makul aralık dışındaysa (±10 dk) istek reddedilir; içindeyse kabul", async () => {
    const send = (n: number, at: number) => writeFileSync(join(store.dir, "inbox", `${cid(n)}.json`), JSON.stringify({ v: 1, cid: cid(n), op: "mode off", argv: ["mode", "off"], requestedAt: new Date(at).toISOString(), requester: "vlad-07" }), { mode: 0o600 });
    start();
    send(1, START - 11 * 60_000); expect(await ackOf(1)).toMatchObject({ status: "invalid", reason: "bad_value" });
    send(2, START + 11 * 60_000); expect(await ackOf(2)).toMatchObject({ status: "invalid", reason: "bad_value" });
    send(3, START - 9 * 60_000); expect((await ackOf(3)).status).toBe("pending");
  });

  it("yanıt akışı hatası: servis ayakta, istek süresi dolar", async () => {
    ch.failWatch = true;
    start();
    request(1);
    const a = await ackOf(1);
    t += LIMITS.approveTtlMs + 1;
    expect((await resultOf(a.id!)).status).toBe("expired");
    expect(logText()).toContain("yanıt akışı hatası");
  });
});

describe("approver: service tekillik ve kurtarma", () => {
  const seed = (over: Partial<PendingRecord> = {}): PendingRecord => {
    const p: PendingRecord = {
      v: 1, id: "m".repeat(26), shortId: "mmmmmmmm", cid: cid(9), op: "mode off", argv: ["mode", "off"], requestedAt: new Date(START).toISOString(), expiresAt: new Date(START + LIMITS.approveTtlMs).toISOString(),
      nonce: "0".repeat(32), respTopic: "vlad-r-" + "m".repeat(26), digest: "1".repeat(64), ctx: { home, kb: join(home, "kb"), cli: "/c" }, keyGen: "0".repeat(16), status: "pending", requester: "vlad-07", ...over,
    };
    if (!over.digest) p.digest = computeDigest(p);
    store.writePending(p);
    return p;
  };

  it("ikinci servis: busy, hata fırlatır", async () => {
    expect(store.acquireLock(process.pid, new Date(t))).toBe("acquired");
    const other = createStore(store.dir, { now: () => new Date(t) });
    await expect(runApprover(deps({ store: other }))).rejects.toMatchObject({ code: "SERVICE_BUSY" });
    store.releaseLock();
  });

  it("servis çıkınca kilit bırakılır", async () => {
    start();
    await waitFor(() => existsSync(join(store.dir, "service.lock")));
    await stop();
    expect(existsSync(join(store.dir, "service.lock"))).toBe(false);
  });

  it.each(["approved", "executing"] as const)("%s kayıt: interrupted, spawn yok", async (status) => {
    const p = seed({ status });
    start();
    expect(await resultOf(p.id)).toMatchObject({ status: "interrupted", exitCode: null });
    expect(execRun).not.toHaveBeenCalled();
    await waitFor(() => store.readPending() === null);
  });

  it("exec işaretçisi var, sonuç yok: interrupted (sonuç bilinmiyor)", async () => {
    const p = seed({ status: "executing" });
    store.markClaim(p.id, "exec");
    start();
    const r = await resultOf(p.id);
    expect(r.status).toBe("interrupted"); expect(r.reason).toContain("sonuç bilinmiyor");
    expect(execRun).not.toHaveBeenCalled();
  });

  it("karar işaretçisi var ama pending hâlâ pending: denied (yarıda kalan karar)", async () => {
    const p = seed();
    store.markClaim(p.id, "decision");
    start();
    expect(await resultOf(p.id)).toMatchObject({ status: "denied" });
    expect(execRun).not.toHaveBeenCalled();
  });

  it("süresi dolan pending: expired", async () => {
    const p = seed();
    t = START + LIMITS.approveTtlMs + 5000;
    start();
    expect((await resultOf(p.id)).status).toBe("expired");
  });

  it("süresi dolmamış pending: yanıt akışına yeniden abone olur, ready'de yayınlar", async () => {
    const p = seed({ keyGen: keyGen(readKey()!) });
    start();
    await waitFor(() => ch.watches.length === 1);
    expect(ch.watches[0]).toEqual({ topic: p.respTopic, since: Math.floor(START / 1000) });
    expect(ch.published).toHaveLength(0);
    ch.ready();
    await waitFor(() => ch.published.length === 1);
  });

  it("bozuk pending.json: fail-closed locked, dosya korunur", async () => {
    writeFileSync(join(store.dir, "pending.json"), "{kesik", { mode: 0o600 });
    start();
    request(1);
    expect(await ackOf(1)).toMatchObject({ status: "locked" });
    expect(readFileSync(join(store.dir, "pending.json"), "utf8")).toBe("{kesik");
    expect(execRun).not.toHaveBeenCalled();
  });

  it("log ve geri bildirimlerde sır yok", async () => {
    start();
    const p = await open(1);
    ch.h!.onBody(body("a1", p));
    await resultOf(p.id);
    expect(secretHits(logText())).toEqual([]);
    expect(logs.join("\n")).not.toContain(readKey()!);
  });
});

describe("approver: service sertleştirme (Codex P1/P2)", () => {
  it("pending dışarıdan silinirse bellekteki istek düşer: yeni istek busy olmaz", async () => {
    start();
    request(1);
    expect((await ackOf(1)).status).toBe("pending");
    store.clearPending();
    t += LIMITS.cooldownMs; // soğuma yok zaten; yalnız aynı durumu açık tut
    request(2);
    expect((await ackOf(2)).status).toBe("pending");
  });

  it("kurtarmada digest uyuşmazsa bekleyen istek yeniden yayınlanmaz: denied digest_mismatch", async () => {
    const p: PendingRecord = {
      v: 1, id: "n".repeat(26), shortId: "nnnnnnnn", cid: cid(9), op: "mode off", argv: ["mode", "off"], requestedAt: new Date(START).toISOString(), expiresAt: new Date(START + LIMITS.approveTtlMs).toISOString(),
      nonce: "0".repeat(32), respTopic: "vlad-r-" + "n".repeat(26), digest: "1".repeat(64), ctx: { home, kb: join(home, "kb"), cli: "/c" }, keyGen: keyGen(readKey()!), status: "pending", requester: "vlad-07",
    };
    store.writePending(p);
    start();
    expect(await resultOf(p.id)).toMatchObject({ status: "denied", reason: "digest_mismatch" });
    expect(execRun).not.toHaveBeenCalled();
  });

  it("sonuç dosyasındaki stdout/stderr sırlardan arındırılır", async () => {
    const hex = "ab".repeat(32);
    execRun.mockImplementation(async () => ({ exitCode: 0, stdout: `x ${hex} VMT2.1.2.3.4 VLAD_MODE_TOKEN=abc vlad-q-${"a".repeat(26)}`, stderr: `vlad-r-${"b".repeat(26)} ${hex}`, timedOut: false }));
    start();
    const p = await open(1);
    ch.h!.onBody(body("a1", p));
    const r = await resultOf(p.id);
    const raw = JSON.stringify(r);
    expect(raw).not.toContain(hex);
    expect(raw).not.toMatch(/VMT2\.|VLAD_MODE_TOKEN=abc|vlad-[qr]-/);
    expect(r.stdout).toContain("[gizli]");
  });
});
