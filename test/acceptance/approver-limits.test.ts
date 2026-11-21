import { statSync, symlinkSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disableKey, initKey, mintToken } from "../../src/mode/token.js";
import { assertSecureDir, writeAtomic } from "../../src/mode/secure-fs.js";
import { LIMITS } from "../../src/approver/types.js";
import type { PendingRecord, PendingStatus } from "../../src/approver/types.js";
import type { Store } from "../../src/approver/store.js";
import type { ServiceInstaller } from "../../src/approver/launchd.js";
import type { ServiceInstaller } from "../../src/approver/launchd.js";
import { b32, digestOf, dirFiles, logText, makeCid, makeWorld, resultOf, runVlad, sleep, startService, submit, untilWatching, waitAck, waitFor, writeRequest } from "./approver-harness.js";
import type { World } from "./approver-harness.js";

// approver-kabul: KK11 kanal kesintisi, KK12 hız sınırı/kilit, çökme sınırları, anahtar yarışları, çıktı/log/kota taşması.
// Saat sahte ve yalnız süreç içi; çökme sınırları, disk üzerinde o sınırın durumu yazılıp servis (yeniden) başlatılarak sınanır.
const NIGHT = ["mode", "night", "--until", "23:00"];
const OFF = ["mode", "off"];
let w: World;
const cwd0 = process.cwd();
beforeEach(async () => { w = await makeWorld(); process.chdir(w.vladHome); }); // mode/approver komutları `vlad/T…` dalındaki cwd'yi çalışan sayar
afterEach(async () => { process.chdir(cwd0); await w.dispose(); });
const boot = async () => { const s = startService(w); await untilWatching(w); return s; };

/** Bir istek-karar turu; ardından soğumayı aşacak kadar saat ilerler. */
async function cycle(argv: string[], label: "Onayla" | "Reddet", advance = LIMITS.cooldownMs + 1000) {
  const r = await submit(w, argv);
  expect(r.ack.status, argv.join(" ")).toBe("pending");
  await w.ntfy.press(r.msg!, label);
  await resultOf(w, r.pending!.id);
  w.clock.advance(advance);
  return r;
}
/** Çağrıdan önce/sonra belirli Store yöntemini araya girerek bozan sarmalayıcı (sahte Store: disk dolu/EACCES). */
function wrapStore(real: Store, hooks: Partial<{ [K in keyof Store]: (...a: Parameters<Extract<Store[K], (...x: never[]) => unknown>>) => void }>): Store {
  return new Proxy(real, { get(t, k, r) { const v = Reflect.get(t, k, r); const h = (hooks as Record<string, (...a: unknown[]) => void>)[k as string]; return typeof v === "function" ? (...a: unknown[]) => { h?.(...a); return v.apply(t, a); } : v; } });
}
const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

/** F-vlad-355: gerçek launchd kurucusu yerine sahte; rotate gerçek ~/Library/LaunchAgents servisini bootout/silip yeniden kurmasın. */
const noopInstaller: ServiceInstaller = { install: async () => [], uninstall: async () => [], status: async () => ({ installed: false, running: false, detail: "sahte" }) };

describe("approver-kabul: KK12 hız sınırı ve kilit", () => {
  it("soğuma: karardan hemen sonra rate_limited; 30 sn sonra kabul", async () => {
    await boot();
    await cycle(NIGHT, "Onayla", 5000);
    const cid = writeRequest(w, { argv: OFF });
    expect((await waitAck(w, cid)).status).toBe("rate_limited");
    expect(w.ntfy.requests).toHaveLength(1); // yalnız ilk istek bildirimi; reddedilen ikinci için yok
    w.clock.advance(LIMITS.cooldownMs);
    expect((await submit(w, OFF)).ack.status).toBe("pending");
  });

  it("saatte 6: 7. istek rate_limited; bir saat sonra yeniden kabul", async () => {
    await boot();
    for (let i = 0; i < LIMITS.perHour; i++) await cycle(i % 2 ? OFF : NIGHT, "Onayla");
    const cid = writeRequest(w, { argv: OFF });
    expect((await waitAck(w, cid)).status).toBe("rate_limited");
    w.clock.advance(3_600_000);
    expect((await submit(w, OFF)).ack.status).toBe("pending");
  }, 45_000);

  it("3 art arda ret ⇒ locked (1 saat); süre dolmadan kilitli kalır, 1 saat dolunca kendiliğinden açılır (erken açmak için `approver unlock`)", async () => {
    await boot();
    for (let i = 0; i < LIMITS.lockAfterDenied; i++) await cycle(OFF, "Reddet"); // her tur sonunda saat soğuma+1 sn ilerler
    const cid = writeRequest(w, { argv: OFF });
    expect((await waitAck(w, cid)).status).toBe("locked");
    w.clock.advance(LIMITS.lockMs - 3 * LIMITS.cooldownMs); // kilit bitişinden önce
    const early = writeRequest(w, { argv: OFF });
    expect((await waitAck(w, early)).status, "süre dolmadan").toBe("locked");
    w.clock.advance(3 * LIMITS.cooldownMs); // toplam > lockMs
    expect((await submit(w, OFF)).ack.status, "1 saat dolunca").toBe("pending");
  }, 45_000);

  it("unlock: TTY'siz / mod yetkisiz / çalışan reddedilir; TTY + geçerli token + çalışan değil ile kilidi açar", async () => {
    await boot();
    for (let i = 0; i < LIMITS.lockAfterDenied; i++) await cycle(OFF, "Reddet");
    const tok = mintToken(60_000, w.clock.now());
    const tty = { isTTY: () => true }, noTty = { isTTY: () => false };
    const base = { VLAD_TASK_ID: undefined as string | undefined, VLAD_MODE_TOKEN: undefined as string | undefined };
    expect((await runVlad(["approver", "unlock"], { approverDeps: noTty, env: { ...base, VLAD_MODE_TOKEN: tok } })).code, "TTY yok").toBe(1);
    expect((await runVlad(["approver", "unlock"], { approverDeps: tty, env: base })).code, "token yok").toBe(1);
    expect((await runVlad(["approver", "unlock"], { approverDeps: tty, env: { ...base, VLAD_MODE_TOKEN: "VMT1.1.x" } })).code, "geçersiz token").toBe(1);
    expect((await runVlad(["approver", "unlock"], { approverDeps: tty, env: { VLAD_TASK_ID: "T20261116-99", VLAD_MODE_TOKEN: tok } })).code, "çalışan").toBe(1);
    const still = writeRequest(w, { argv: OFF });
    expect((await waitAck(w, still)).status, "reddedilen unlock kilidi açmamalı").toBe("locked");
    const ok = await runVlad(["approver", "unlock"], { approverDeps: tty, env: { ...base, VLAD_MODE_TOKEN: tok } });
    expect(ok.code, ok.err).toBe(0);
    expect((await submit(w, OFF)).ack.status).toBe("pending");
  }, 45_000);

  it.each([
    ["kesik JSON", (f: string) => writeAtomic(f, '{"v":1,"decisions":["2026', { overwrite: true })],
    ["yanlış izin (0644)", (f: string) => { writeAtomic(f, JSON.stringify({ v: 1, decisions: [], consecutiveDenied: 0, lockedUntil: null }), { overwrite: true }); chmodSync(f, 0o644); }],
    ["sembolik bağ", (f: string) => { rmSync(f, { force: true }); symlinkSync(join(w.root, "baska.json"), f); }],
  ])("bozuk rate.json (%s): fail-closed locked/rate_state_corrupt; sayaç sıfırlanmaz", async (_n, corrupt) => {
    await boot();
    const f = join(w.dir, "rate.json");
    writeAtomic(f, JSON.stringify({ v: 1, decisions: [w.clock.now().toISOString()], consecutiveDenied: 2, lockedUntil: null }), { overwrite: true });
    corrupt(f);
    const before = (() => { try { return readFileSync(f, "utf8"); } catch { return null; } })();
    const cid = writeRequest(w, { argv: OFF });
    const ack = await waitAck(w, cid);
    expect(ack).toMatchObject({ status: "locked", reason: "rate_state_corrupt" });
    expect(w.ntfy.published).toHaveLength(0);
    const after = (() => { try { return readFileSync(f, "utf8"); } catch { return null; } })();
    expect(after).toBe(before); // sıfırlanıp yeniden yazılmadı
  });

  it("saat geri alınırsa (negatif geçen süre) soğuma sürüyor sayılır", async () => {
    await boot();
    await cycle(NIGHT, "Onayla", -10 * 60_000);
    const cid = writeRequest(w, { argv: OFF });
    expect((await waitAck(w, cid)).status).toBe("rate_limited");
  });

  it("bozuk pending.json (kesik JSON): servis çökmez, yeni istek kabul edilmez ve bildirim yayınlanmaz", async () => {
    const svc = await boot();
    writeAtomic(join(w.dir, "pending.json"), '{"v":1,"id":"', { overwrite: true });
    const cid = writeRequest(w, { argv: OFF });
    await sleep(600);
    const ack = await waitAck(w, cid).catch(() => null);
    expect(ack === null || ack.status !== "pending").toBe(true);
    expect(w.ntfy.published).toHaveLength(0);
    expect(w.exec.calls).toHaveLength(0);
    expect(svc.settled()).toBe(false);
  });
});

describe("approver-kabul: KK11 kanal kesintisi", () => {
  it("yanıt akışı `ready` olmadan bildirim yayınlanmaz; hazır olunca yayınlanır", async () => {
    w.ntfy.holdOpen = true;
    startService(w);
    const cid = writeRequest(w, { argv: NIGHT }); // akış yalnız istek başına açılır (plan)
    await waitFor(() => w.store.readPending(), "pending.json yazıldı");
    await waitFor(() => w.ntfy.connections.length > 0, "akış isteği");
    await sleep(400);
    expect(w.ntfy.published, "ready yok").toHaveLength(0);
    w.ntfy.releaseOpen();
    await waitFor(() => w.ntfy.requests.length === 1, "ready sonrası yayın");
    expect((await waitAck(w, cid)).status).toBe("pending");
  });

  it("yayın 500: servis çökmez, yürütme yok; sonra (TTL geçince) yeni istek kabul edilir", async () => {
    const svc = await boot();
    w.ntfy.failPublish.push({ status: 500 }, { status: 500 }, { status: 500 });
    writeRequest(w, { argv: NIGHT });
    await sleep(800);
    expect(svc.settled()).toBe(false);
    expect(w.exec.calls).toHaveLength(0);
    w.clock.advance(LIMITS.approveTtlMs + 1000);
    w.ntfy.failPublish.length = 0;
    const r = await submit(w, OFF);
    expect(r.ack.status).toBe("pending");
  });

  it("akış 429 Retry-After: bir sonraki bağlantı beklemeye uyar (≥ ~2 sn) ve servis çökmez", async () => {
    w.ntfy.failStream.push({ status: 429, retryAfter: 2 });
    const svc = startService(w);
    writeRequest(w, { argv: NIGHT }); // ilk istek akışı 429 alır
    await waitFor(() => w.ntfy.connections.length >= 2, "ikinci bağlantı", 12_000);
    expect(w.ntfy.connections[1]!.at - w.ntfy.connections[0]!.at).toBeGreaterThanOrEqual(1800);
    expect(svc.settled()).toBe(false);
  }, 20_000);

  it("akış kopunca son olay kimliğiyle (since=<id>) yeniden bağlanır; ilk bağlantı since sayısal (unix)", async () => {
    await boot();
    const { pending: p } = await submit(w, NIGHT);
    await waitFor(() => w.ntfy.connections.length > 0, "ilk akış");
    expect(w.ntfy.connections[0]!.since).toMatch(/^\d+$/);
    w.ntfy.emit(p!.respTopic, "çöp"); // bir `message` olayı = imleç ilerler
    await sleep(100);
    const last = w.ntfy.lastEventId();
    w.ntfy.dropStreams();
    await waitFor(() => w.ntfy.connections.length >= 2, "yeniden bağlanma", 10_000);
    expect(w.ntfy.connections[1]!.topic).toBe(p!.respTopic);
    expect(w.ntfy.connections[1]!.since).toBe(last);
  }, 20_000);

  it("ntfy tamamen kapalı: servis çökmez, yürütme yok", async () => {
    const svc = await boot();
    await w.ntfy.stop();
    writeRequest(w, { argv: NIGHT });
    await sleep(1200);
    expect(svc.settled()).toBe(false);
    expect(w.exec.calls).toHaveLength(0);
  });
});

/** Diskte belirli bir sınırın durumunu kurar (servis o sırada ölmüş gibi). */
function seed(status: PendingStatus, o: { expired?: boolean } = {}): PendingRecord {
  const now = w.clock.now().getTime();
  const id = b32(Buffer.from(String(Math.random()) + status + now));
  const p: PendingRecord = {
    v: 1, id, shortId: id.slice(0, 8), cid: makeCid(), op: "mode night", argv: NIGHT,
    requestedAt: new Date(now - (o.expired ? 600_000 : 1000)).toISOString(), expiresAt: new Date(now + (o.expired ? -300_000 : 300_000)).toISOString(),
    nonce: "ab".repeat(16), respTopic: "vlad-r-" + b32(Buffer.from(id + "r")), digest: "", keyGen: "0123456789abcdef", status, requester: "vlad-07",
    ctx: { home: w.vladHome, kb: join(w.vladHome, "kb"), cli: join(w.vladHome, "dist", "cli.js") },
  };
  p.digest = digestOf(p);
  w.store.writePending(p);
  return p;
}

describe("approver-kabul: çökme sınırları (kurtarma hiçbir durumda yeniden çalıştırmaz)", () => {
  it("approved yazıldı, exec işaretçisi yok ⇒ interrupted, spawn 0", async () => {
    const p = seed("approved"); w.store.markClaim(p.id, "decision");
    await boot();
    const r = await resultOf(w, p.id);
    expect(r.status).toBe("interrupted");
    expect(w.exec.calls).toHaveLength(0);
  });
  it("exec işaretçisi var, sonuç yok ⇒ interrupted (sonuç bilinmiyor), spawn 0", async () => {
    const p = seed("executing"); w.store.markClaim(p.id, "decision"); w.store.markClaim(p.id, "exec");
    await boot();
    const r = await resultOf(w, p.id);
    expect(r.status).toBe("interrupted");
    expect(r.reason ?? "").toMatch(/\S/);
    await sleep(200);
    expect(w.exec.calls).toHaveLength(0);
  });
  it("süresi dolan pending ⇒ expired; sonra yeni istek kabul edilir", async () => {
    const p = seed("pending", { expired: true });
    await boot();
    expect((await resultOf(w, p.id)).status).toBe("expired");
    expect(w.exec.calls).toHaveLength(0);
    w.clock.advance(LIMITS.cooldownMs + 1000);
    expect((await submit(w, OFF)).ack.status).toBe("pending");
  });
  it("yeniden başlatma yürütmeyi tekrarlamaz: onay → yürütme sürerken servis durdurulur → yeni servis interrupted yazar, spawn toplam 1", async () => {
    const s1 = await boot();
    w.exec.hold();
    const { pending: p, msg } = await submit(w, NIGHT);
    await w.ntfy.press(msg!, "Onayla");
    await waitFor(() => w.exec.calls.length === 1, "yürütme başladı");
    await s1.stop(); // exec.hold sürerken: yürütücü bitmeden servis ölür (sonuç yazılmadı)
    w.exec.release();
    await sleep(100);
    if (!w.store.readResult(p!.id)) {
      startService(w);
      expect((await resultOf(w, p!.id)).status).toBe("interrupted");
    }
    await sleep(200);
    expect(w.exec.calls).toHaveLength(1);
  });
  it("sahte Store: pending→approved yazılamaz (EACCES) ⇒ spawn edilmez, servis çökmez", async () => {
    const store = wrapStore(w.store, { writePending: (p: PendingRecord) => { if (p.status === "approved") throw eacces(); } });
    const svc = startService(w, { store }); await untilWatching(w);
    const { msg } = await submit(w, NIGHT);
    await w.ntfy.press(msg!, "Onayla");
    await sleep(600);
    expect(w.exec.calls).toHaveLength(0);
    expect(svc.settled()).toBe(false);
  });
  it("sahte Store: exec işaretçisi yazılamaz ⇒ spawn edilmez", async () => {
    const store = wrapStore(w.store, { markClaim: (_id: string, kind: "decision" | "exec") => { if (kind === "exec") throw eacces(); } });
    startService(w, { store }); await untilWatching(w);
    const { msg } = await submit(w, NIGHT);
    await w.ntfy.press(msg!, "Onayla");
    await sleep(600);
    expect(w.exec.calls).toHaveLength(0);
  });
  it("sahte Store: sonuç yazılamaz ⇒ yürütme yine tek kez, servis çökmez", async () => {
    const store = wrapStore(w.store, { writeResult: () => { throw eacces(); } });
    const svc = startService(w, { store }); await untilWatching(w);
    const { msg } = await submit(w, NIGHT);
    await w.ntfy.press(msg!, "Onayla");
    await waitFor(() => w.exec.calls.length === 1, "yürütme");
    await sleep(400);
    expect(w.exec.calls).toHaveLength(1);
    expect(svc.settled()).toBe(false);
  });
});

describe("approver-kabul: anahtar yarışları, rotate", () => {
  it("onay ile `mode token --reset` yarışı: spawn öncesi keyGen doğrulaması reddeder (denied: key_changed), spawn 0", async () => {
    const store = wrapStore(w.store, { writePending: (p: PendingRecord) => { if (p.status === "approved") initKey(true); } });
    startService(w, { store }); await untilWatching(w);
    const { pending: p, msg } = await submit(w, NIGHT);
    await w.ntfy.press(msg!, "Onayla");
    const r = await resultOf(w, p!.id);
    expect(r.status).toBe("denied");
    expect(`${r.reason}`).toMatch(/key_changed/);
    expect(w.exec.calls).toHaveLength(0);
  });
  it("onay ile `mode token --disable` yarışı: spawn 0, servis çökmez", async () => {
    const store = wrapStore(w.store, { writePending: (p: PendingRecord) => { if (p.status === "approved") disableKey(); } });
    const svc = startService(w, { store }); await untilWatching(w);
    const { msg } = await submit(w, NIGHT);
    await w.ntfy.press(msg!, "Onayla");
    await sleep(800);
    expect(w.exec.calls).toHaveLength(0);
    expect(svc.settled()).toBe(false);
  });
  it("bekleyen varken --disable: onay etkisiz (yürütme yok), servis çökmez", async () => {
    const svc = await boot();
    const { msg } = await submit(w, NIGHT);
    disableKey();
    await w.ntfy.press(msg!, "Onayla");
    await sleep(600);
    expect(w.exec.calls).toHaveLength(0);
    expect(svc.settled()).toBe(false);
  });
  it("rotate: yeni istek konusu üretir, bekleyeni reddeder (denied: rotated); TTY'siz reddedilir ve channel.json değişmez", async () => {
    await boot();
    const { pending: p } = await submit(w, NIGHT);
    const chFile = join(w.dir, "channel.json");
    const old = JSON.parse(readFileSync(chFile, "utf8")).requestTopic as string;
    const tok = mintToken(60_000, w.clock.now());
    const env = { VLAD_TASK_ID: undefined, VLAD_MODE_TOKEN: tok };
    const no = await runVlad(["approver", "rotate"], { approverDeps: { isTTY: () => false, installer: noopInstaller }, env });
    expect(no.code).toBe(1);
    expect(JSON.parse(readFileSync(chFile, "utf8")).requestTopic).toBe(old);
    const ok = await runVlad(["approver", "rotate"], { approverDeps: { isTTY: () => true, installer: noopInstaller }, env: { VLAD_TASK_ID: undefined, VLAD_MODE_TOKEN: mintToken(60_000, w.clock.now()) } });
    expect(ok.code, ok.err).toBe(0);
    const fresh = JSON.parse(readFileSync(chFile, "utf8")).requestTopic as string;
    expect(fresh).toMatch(/^vlad-q-[a-z2-7]{26}$/); expect(fresh).not.toBe(old);
    expect(ok.out).toContain(fresh); // yeni abonelik URL'si yalnız TTY'ye
    expect(ok.out).not.toContain(old);
    const r = await resultOf(w, p!.id);
    expect(r.status).toBe("denied"); expect(`${r.reason}`).toMatch(/rotated/);
    expect(w.exec.calls).toHaveLength(0);
  });
});

describe("approver-kabul: çıktı/log/kota taşması", () => {
  it("1 MB stdout: sonuç ≤ 2 KB; telefona ham stdout gitmez (yalnız durum, çıkış kodu)", async () => {
    await boot();
    w.exec.reply = { exitCode: 0, stdout: "STDOUT-MARK-" + "x".repeat(1_000_000), stderr: "STDERR-MARK", timedOut: false };
    const { pending: p, msg } = await submit(w, NIGHT);
    await w.ntfy.press(msg!, "Onayla");
    const r = await resultOf(w, p!.id);
    expect(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(2048 + 64);
    await waitFor(() => w.ntfy.published.length >= 2, "sonuç bildirimi");
    const later = JSON.stringify(w.ntfy.published.slice(1).map((m) => m.raw));
    expect(later).not.toMatch(/STDOUT-MARK|STDERR-MARK|xxxxxxxx/);
    expect(logText(w)).not.toMatch(/STDOUT-MARK|xxxxxxxx/);
  });
  it("inbox kotası: ≤ 20 dosya ve ≤ 160 KB; fazlası silinir ve `oversize` loglanır", () => {
    assertSecureDir(join(w.dir, "inbox"));
    for (let i = 0; i < 25; i++) writeAtomic(join(w.dir, "inbox", `${makeCid()}.json`), JSON.stringify({ pad: "x".repeat(2000) }), { overwrite: false });
    const kept = w.store.listInbox();
    expect(kept.length).toBeLessThanOrEqual(LIMITS.maxInboxFiles);
    expect(dirFiles(join(w.dir, "inbox")).length).toBeLessThanOrEqual(LIMITS.maxInboxFiles);
    expect(logText(w)).toContain("oversize");
  });
  it("inbox boyut kotası: toplam ≤ 160 KB", () => {
    assertSecureDir(join(w.dir, "inbox"));
    for (let i = 0; i < 6; i++) writeAtomic(join(w.dir, "inbox", `${makeCid()}.json`), "x".repeat(60_000), { overwrite: false });
    w.store.listInbox();
    const total = dirFiles(join(w.dir, "inbox")).reduce((n, f) => n + statSync(join(w.dir, "inbox", f)).size, 0);
    expect(total).toBeLessThanOrEqual(LIMITS.maxInboxBytes);
  });
  it("approver.log 256 KB'de döner (.1) ve şişmez", () => {
    const line = "olay ".repeat(40);
    for (let i = 0; i < 2000; i++) w.store.log(`${i} ${line}`);
    expect(dirFiles(w.dir)).toContain("approver.log.1");
    expect(statSync(join(w.dir, "approver.log")).size).toBeLessThanOrEqual(256 * 1024 + 512);
  });
});
