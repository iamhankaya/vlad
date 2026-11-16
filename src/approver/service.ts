import { realpathSync } from "node:fs";
import { join } from "node:path";
import { getVladHome, resolveKbDir } from "../kb/home.js";
import { keyState, mintOpToken, readKey } from "../mode/token.js";
import type { ApproverChannel } from "./ntfy.js";
import type { Executor } from "./exec.js";
import { approveTag, computeDigest, denyTag, keyGen, newId, newNonce, newTopic, parseDecision, validateRequest, type RandomSource } from "./request.js";
import type { Store } from "./store.js";
import { LIMITS, type AckRecord, type Ctx, type DropReason, type PendingRecord, type ResultRecord, type ResultStatus } from "./types.js";

/**
 * Servis durum makinesi: pending → approved → executing → (ResultRecord); pending → denied|expired.
 * Kurallar (plan "Protokol"): inbox→claimed `rename` sahiplenme, ack, kontrol sırası invalid→key_disabled→locked→busy→rate_limited, `ready` olmadan yayın yok,
 * karar tüketimi tek senkron blokta (ilk geçerli karar kazanır), kurtarma hiçbir durumda yeniden çalıştırmaz (`interrupted`), spawn öncesi keyGen/ctx yeniden doğrulama.
 * Test seam kuralı: Executor/Clock/RandomSource enjeksiyonu yalnız bu `deps`'ten gelir; üretim `approver run` sabit deps kurar, `VLAD_*` env'den seam okumaz.
 */
export interface Clock { now(): Date }
export interface ApproverDeps { channel: ApproverChannel; clock: Clock; random: RandomSource; executor: Executor; store: Store; log(l: string): void; signal: AbortSignal }

const POLL_MS = 200, DROP_LOG_MS = 10_000, TEXT_MAX = 2048, HOUR = 3_600_000, DAY = 86_400_000;
const clip = (s: string): string => (Buffer.byteLength(s) <= TEXT_MAX ? s : Buffer.from(s).subarray(0, TEXT_MAX).toString("utf8"));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((res) => {
  if (signal.aborted) return res();
  const t = setTimeout(done, ms);
  function done(): void { clearTimeout(t); signal.removeEventListener("abort", done); res(); }
  signal.addEventListener("abort", done);
});

/** Servisin bağlamı: VLAD_HOME (tek izinli VLAD_* okuması, `getVladHome`), kb dizini, çalışan CLI'nin gerçek yolu. İstek içeriğinden etkilenmez; yürütmeden hemen önce yeniden çözülüp pending'dekiyle karşılaştırılır. */
function resolveCtx(): Ctx {
  const home = getVladHome();
  let cli = join(home, "dist", "cli.js");
  try { if (process.argv[1]) cli = realpathSync(process.argv[1]); } catch { /* varsayılan kalır */ }
  return { home, kb: resolveKbDir(home).dir, cli };
}
const sameCtx = (a: Ctx, b: Ctx): boolean => a.home === b.home && a.kb === b.kb && a.cli === b.cli;
const keyOk = (): string | null => { if (keyState() !== "ok") return null; try { return readKey(); } catch { return null; } };

export async function runApprover(deps: ApproverDeps): Promise<void> {
  const { channel, clock, random, executor, store, signal } = deps;
  const L = (s: string): void => { store.log(s); try { deps.log(s); } catch { /* günlük hatası servisi durdurmaz */ } };
  const iso = (ms: number): string => new Date(ms).toISOString();
  const nowMs = (): number => clock.now().getTime();

  if (store.acquireLock(process.pid, clock.now()) === "busy") throw Object.assign(new Error("başka servis çalışıyor"), { code: "SERVICE_BUSY" });

  let cur: PendingRecord | null = null, pendingBad = false, watch: AbortController | null = null, running: Promise<void> | null = null;
  const dropSeen = new Map<DropReason, number>();

  const ack = (a: AckRecord): void => { try { store.writeAck(a); } catch (e) { L(`ack yazılamadı: ${msg(e)}`); } };
  const drop = (r: DropReason): void => {
    const last = dropSeen.get(r), t = nowMs();
    if (last !== undefined && Math.abs(t - last) < DROP_LOG_MS) return;
    dropSeen.set(r, t);
    L(`yanıt düşürüldü: ${r}`);
  };

  // --- hız sınırı ---
  const recordRate = (kind: "approve" | "deny" | "expire"): void => {
    const r = store.readRate(), t = nowMs();
    const consecutive = kind === "approve" ? 0 : r.consecutiveDenied + 1;
    store.writeRate({
      v: 1, decisions: [...r.decisions.filter((d) => !(t - Date.parse(d) >= DAY)), iso(t)], consecutiveDenied: consecutive,
      lockedUntil: consecutive >= LIMITS.lockAfterDenied ? iso(t + LIMITS.lockMs) : r.lockedUntil,
    });
  };
  const rateCheck = (): { lock: "corrupt" | "locked" | null; limited: boolean } => {
    let r;
    try { r = store.readRate(); } catch (e) { L(`rate.json okunamadı: ${msg(e)}`); return { lock: "corrupt", limited: false }; }
    const t = nowMs();
    if (r.lockedUntil !== null) {
      const u = Date.parse(r.lockedUntil);
      if (Number.isNaN(u) || t < u) return { lock: "locked", limited: false };
      r = { ...r, lockedUntil: null, consecutiveDenied: 0 }; // kilit süresi doldu
      try { store.writeRate(r); } catch (e) { L(`rate.json yazılamadı: ${msg(e)}`); }
    }
    const ts = r.decisions.map((d) => Date.parse(d));
    if (ts.some(Number.isNaN)) return { lock: "corrupt", limited: false };
    const limited = ts.length > 0 && (!(t - Math.max(...ts) >= LIMITS.cooldownMs) || ts.filter((x) => t - x < HOUR).length >= LIMITS.perHour || ts.filter((x) => t - x < DAY).length >= LIMITS.perDay);
    return { lock: null, limited };
  };

  // --- sonuçlandırma ---
  const settle = (p: PendingRecord, r: { status: ResultStatus; exitCode?: number | null; stdout?: string; stderr?: string; reason?: string }, kind: "approve" | "deny" | "expire" | null): void => {
    const rec: ResultRecord = { v: 1, id: p.id, status: r.status, exitCode: r.exitCode ?? null, stdout: clip(r.stdout ?? ""), stderr: clip(r.stderr ?? ""), ...(r.reason ? { reason: r.reason } : {}), finishedAt: iso(nowMs()) };
    try { store.writeResult(rec); } catch (e) { L(`sonuç yazılamadı: ${msg(e)}`); }
    if (kind) { try { recordRate(kind); } catch (e) { L(`hız sınırı yazılamadı: ${msg(e)}`); } }
    try { store.clearPending(); } catch (e) { L(`pending.json silinemedi: ${msg(e)}`); }
    if (cur?.id === p.id) { cur = null; watch?.abort(); watch = null; }
    void Promise.resolve().then(() => channel.publishResult(rec)).catch((e) => L(`sonuç bildirimi gönderilemedi: ${msg(e)}`));
  };

  // --- yürütme ---
  const execute = async (p: PendingRecord): Promise<void> => {
    try {
      if (!store.markClaim(p.id, "exec")) return settle(p, { status: "interrupted", reason: "yürütme işaretçisi zaten var; çalıştırılmadı" }, "approve");
      const key = keyOk();
      if (!key || keyGen(key) !== p.keyGen) return settle(p, { status: "denied", reason: "key_changed" }, "approve");
      if (!sameCtx(resolveCtx(), p.ctx)) return settle(p, { status: "denied", reason: "ctx_changed" }, "approve");
      const running_: PendingRecord = { ...p, status: "executing" };
      store.writePending(running_); // yazılamazsa spawn edilmez
      cur = running_;
      const token = mintOpToken(p.argv, LIMITS.tokenTtlMs, clock.now());
      const r = await executor.run(p.argv, token, p.ctx, { signal });
      const status: ResultStatus = r.aborted ? "interrupted" : r.timedOut ? "failed" : r.exitCode === 0 ? "done" : "failed";
      const reason = r.aborted ? "servis durduruldu" : r.timedOut ? "zaman aşımı" : undefined;
      settle(p, { status, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ...(reason ? { reason } : {}) }, "approve");
    } catch (e) {
      settle(p, { status: "failed", reason: `yürütme hatası: ${msg(e)}` }, "approve");
    }
  };

  // --- yanıt kanalı ---
  const onBody = (body: string): void => {
    const p = cur;
    if (!p) return drop("not_pending");
    const key = keyOk();
    if (!key) return drop("bad_tag");
    const d = parseDecision(body, p, key, clock.now());
    if ("drop" in d) return drop(d.drop);
    // Karar tüketimi: await yok; ilk geçerli karar kazanır (bellekteki durum aynı gövdeli ikinci çağrıyı not_pending'e düşürür).
    try { if (!store.markClaim(p.id, "decision")) return drop("not_pending"); } catch (e) { L(`karar işaretçisi yazılamadı: ${msg(e)}`); return; }
    const next: PendingRecord = { ...p, status: d.decision === "approve" ? "approved" : "denied" };
    cur = next;
    try { store.writePending(next); } catch (e) { L(`pending.json yazılamadı: ${msg(e)}`); return settle(p, { status: "denied", reason: "yazma hatası; çalıştırılmadı" }, null); }
    if (d.decision === "deny") return settle(next, { status: "denied", reason: "reddedildi" }, "deny");
    running = execute(next).finally(() => { running = null; });
  };

  const startWatch = (p: PendingRecord, sinceUnix: number): void => {
    const ac = new AbortController();
    watch = ac;
    const stop = (): void => ac.abort();
    signal.addEventListener("abort", stop, { once: true });
    let published = false;
    const onReady = (): void => { // `ready` olmadan yayın yok; yeniden bağlanmada tekrar yayınlanmaz
      if (published || cur?.id !== p.id || cur.status !== "pending") return;
      const key = keyOk();
      if (!key) return L("anahtar yok: istek yayınlanmadı");
      published = true;
      void Promise.resolve().then(() => channel.publishRequest(p, { approve: approveTag(key, p.digest), deny: denyTag(key, p.digest) })).catch((e) => L(`istek bildirimi gönderilemedi: ${msg(e)}`));
    };
    void Promise.resolve().then(() => channel.watchResponse(p.respTopic, sinceUnix, { onBody, onReady }, ac.signal)).catch((e) => L(`yanıt akışı hatası: ${msg(e)}`));
  };

  // --- gelen istekler ---
  const handle = (cid: string): void => {
    let buf: Buffer | null;
    try { buf = store.claimInbox(cid); } catch (e) { L(`istek okunamadı: ${msg(e)}`); return ack({ v: 1, cid, status: "invalid", reason: "bad_value" }); }
    if (!buf) return;
    let raw: unknown;
    try { raw = JSON.parse(buf.toString("utf8")); } catch { return ack({ v: 1, cid, status: "invalid", reason: "bad_value" }); }
    const v = validateRequest(raw);
    if (!v.ok) { L(`istek reddedildi: ${v.reason}`); return ack({ v: 1, cid, status: "invalid", reason: v.reason }); }
    if (v.req.cid !== cid) return ack({ v: 1, cid, status: "invalid", reason: "bad_value" });
    const key = keyOk();
    if (!key) return ack({ v: 1, cid, status: "invalid", reason: "key_disabled" });
    const rate = rateCheck();
    if (pendingBad) return ack({ v: 1, cid, status: "locked" });
    if (rate.lock) return ack({ v: 1, cid, status: "locked", ...(rate.lock === "corrupt" ? { reason: "rate_state_corrupt" as const } : {}) });
    if (cur) return ack({ v: 1, cid, status: "busy" });
    if (rate.limited) return ack({ v: 1, cid, status: "rate_limited" });

    const t = nowMs(), id = newId(random), nonce = newNonce(random), respTopic = newTopic("vlad-r-", random), expiresAt = iso(t + LIMITS.approveTtlMs), ctx = resolveCtx();
    const { op, argv, requestedAt, requester } = v.req;
    const p: PendingRecord = {
      v: 1, id, shortId: id.slice(0, 8), cid, op, argv, requestedAt, expiresAt, nonce, respTopic, ctx, keyGen: keyGen(key), status: "pending", requester,
      digest: computeDigest({ id, argv, requestedAt, expiresAt, nonce, requester, ctx }),
    };
    try { store.writePending(p); } catch (e) { L(`pending.json yazılamadı: ${msg(e)}`); return ack({ v: 1, cid, status: "locked" }); }
    cur = p;
    ack({ v: 1, cid, status: "pending", id, expiresAt });
    startWatch(p, Math.floor(t / 1000));
  };

  const tick = (): void => {
    const p = cur;
    if (p?.status === "pending") {
      const key = keyOk();
      if (!(nowMs() < Date.parse(p.expiresAt))) settle(p, { status: "expired", reason: "süre doldu" }, "expire");
      else if (!key || keyGen(key) !== p.keyGen) settle(p, { status: "denied", reason: "key_changed" }, null);
    }
    if (pendingBad) { try { if (store.readPending() === null) pendingBad = false; } catch { /* hâlâ bozuk */ } }
    for (const cid of store.listInbox()) handle(cid);
  };

  // --- kurtarma: hiçbir durumda yeniden çalıştırılmaz ---
  const recover = (p: PendingRecord): void => {
    let done: ResultRecord | null = null;
    try { done = store.readResult(p.id); } catch { /* bozuk sonuç: üzerine yazılmaz, aşağıda loglanır */ }
    if (done) { store.clearPending(); return; }
    const execStarted = store.hasClaim(p.id, "exec");
    if (p.status === "approved" || p.status === "executing" || execStarted) {
      return settle(p, { status: "interrupted", reason: execStarted ? "servis yeniden başladı; sonuç bilinmiyor, terminalde `vlad mode status` ile doğrula" : "servis yeniden başladı; çalıştırılmadı" }, "approve");
    }
    if (p.status === "denied") return settle(p, { status: "denied", reason: "reddedildi" }, "deny");
    if (p.status === "expired" || !(nowMs() < Date.parse(p.expiresAt))) return settle(p, { status: "expired", reason: "süre doldu" }, "expire");
    if (store.hasClaim(p.id, "decision")) return settle(p, { status: "denied", reason: "karar yarıda kaldı; çalıştırılmadı" }, null);
    cur = p; // süresi dolmamış bekleyen istek: yanıt akışına yeniden abone ol
    startWatch(p, Math.floor((Date.parse(p.expiresAt) - LIMITS.approveTtlMs) / 1000));
  };

  try {
    try { const p = store.readPending(); if (p) recover(p); } catch (e) { pendingBad = true; L(`pending.json bozuk (fail-closed, kilitli): ${msg(e)}`); }
    while (!signal.aborted) {
      try { tick(); } catch (e) { L(`döngü hatası: ${msg(e)}`); }
      await sleep(POLL_MS, signal);
    }
  } finally {
    (watch as AbortController | null)?.abort();
    await (running as Promise<void> | null); // executor `signal` ile grubu öldürür; sonuç `interrupted` yazılır
    store.releaseLock();
  }
}
