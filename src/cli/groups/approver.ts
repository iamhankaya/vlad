import { lstatSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Command } from "commander";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";
import { getVladHome } from "../../kb/home.js";
import { assertNotWorker } from "../../mode/guard.js";
import { NAME_RE, assertSecureDir, readSecureFile, writeAtomic } from "../../mode/secure-fs.js";
import { approverDir, keyState, requireModeAuthority } from "../../mode/token.js";
import { createExecutor } from "../../approver/exec.js";
import { NtfyChannel } from "../../approver/ntfy.js";
import { newId, newTopic, validateRequest, type RandomSource } from "../../approver/request.js";
import { runApprover } from "../../approver/service.js";
import { createStore, type Store } from "../../approver/store.js";
import { LIMITS, type AckRecord, type ChannelConfig, type ResultRecord } from "../../approver/types.js";
import type { ServiceInstaller } from "../../approver/launchd.js";

/**
 * Uzaktan onay servisi CLI'ı (T20261116-06: U4 + U5) ve `mode request` istemcisi.
 * Gizli çıktı (abonelik URL'si) `out` kitinin dışında, yalnız stdout TTY ise ve `--json` yokken doğrudan stdout'a basılır.
 * Test enjeksiyonu yalnız `registerApprover(…, deps)` / `requestApproval(…, deps)` ile; üretim yolu VLAD_* env'den seam okumaz.
 */
export interface ApproverCliDeps {
  /** install/uninstall/rotate/unlock için TTY denetimi (testte enjekte edilir). Varsayılan: stdin TTY. */
  isTTY?: () => boolean;
  /** Gizli çıktının yazıldığı akış (varsayılan process.stdout). */
  stdout?: { isTTY?: boolean; write(s: string): unknown };
  /** Servis kurucusu (varsayılan: launchd, dinamik import). */
  installer?: ServiceInstaller;
  random?: RandomSource;
  now?: () => Date;
}

/** `mode request` istemcisi için enjeksiyon: saat/uyku/rastgelelik sahte olabilir. */
export interface RequestClientDeps {
  random?: RandomSource;
  /** ms cinsinden saat (varsayılan Date.now). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ackWaitMs?: number;
  pollMs?: number;
}

const realRandom: RandomSource = { bytes: (n) => randomBytes(n) };
const errno = (e: unknown, code: string): boolean => (e as NodeJS.ErrnoException).code === code;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DEFAULT_SERVER = "https://ntfy.sh";
const WAIT_DEFAULT_S = (LIMITS.approveTtlMs + LIMITS.waitSlackMs) / 1000;

// --- mode request istemcisi ---
const ACK_STATUS = ["pending", "busy", "rate_limited", "locked", "invalid"];
const RESULT_STATUS = ["done", "failed", "interrupted", "denied", "expired"];

function readJsonFile(path: string, max: number): unknown | null {
  try { return JSON.parse(readSecureFile(path, max).toString("utf8")); } catch (e) { if (errno(e, "ENOENT")) return null; throw e; }
}

export interface RequestOutcome { data: Record<string, unknown>; text: string; exit: 0 | 1 }

/**
 * Hata sırası: (1) çalışan, (2) geçersiz işlem/argüman, (3) approver kurulu değil, (4) servis ack'i, (5) yanıt yok.
 * Anahtarı/channel.json içeriğini okumaz; nonce/tag/konu üretmez; VLAD_MODE_TOKEN istemez.
 */
export async function requestApproval(op: string, args: string[], o: Record<string, unknown>, d: RequestClientDeps = {}): Promise<RequestOutcome> {
  try { assertNotWorker(); } catch { throw new Error("çalışan oturumu uzaktan onay isteği yazamaz"); }
  const head: Record<string, string[]> = { night: ["mode", "night"], watch: ["mode", "watch"], off: ["mode", "off"], install: ["install"], setup: ["setup"] };
  if (!Object.hasOwn(head, op)) throw new Error("geçersiz işlem/argüman: op izinli değil (night|watch|off|install|setup)");
  const random = d.random ?? realRandom, now = d.now ?? Date.now, sleep = d.sleep ?? realSleep, pollMs = d.pollMs ?? 250;
  let waitMs: number | null = null;
  if (o.wait === true || o.waitSeconds !== undefined) {
    const s = o.waitSeconds === undefined ? WAIT_DEFAULT_S : Number(o.waitSeconds);
    if (!(s > 0 && s <= 3600)) throw new Error("--wait-seconds 1-3600 arası olmalı");
    waitMs = s * 1000;
  }
  const cid = newId(random);
  const req = { v: 1, cid, op: op === "install" || op === "setup" ? op : `mode ${op}`, argv: [...head[op]!, ...args], requestedAt: new Date(now()).toISOString(), requester: "vlad" };
  const verdict = validateRequest(req);
  if (!verdict.ok) throw new Error(`geçersiz işlem/argüman: ${verdict.detail}`);

  const dir = approverDir();
  try { lstatSync(join(dir, "channel.json")); } catch (e) {
    if (errno(e, "ENOENT")) throw new Error("approver kurulu değil: önce terminalde vlad approver install");
    throw e;
  }
  const inbox = join(dir, "inbox"), inboxFile = join(inbox, `${cid}.json`), ackFile = join(dir, "ack", `${cid}.json`);
  assertSecureDir(inbox);
  writeAtomic(inboxFile, JSON.stringify(req), { overwrite: false });

  const ackLimit = now() + (d.ackWaitMs ?? LIMITS.ackWaitMs);
  let ack: AckRecord | null = null;
  for (;;) {
    const raw = readJsonFile(ackFile, 4096) as AckRecord | null;
    if (raw) {
      if (typeof raw !== "object" || raw.cid !== cid || !ACK_STATUS.includes(raw.status)) throw new Error("approver yanıtı geçersiz");
      ack = raw; break;
    }
    if (now() >= ackLimit) break;
    await sleep(pollMs);
  }
  if (!ack) {
    try { unlinkSync(inboxFile); } catch { /* servis bu arada sahiplendi */ }
    throw new Error("approver yanıt vermiyor: servis çalışmıyor olabilir (vlad approver status)");
  }
  try { unlinkSync(ackFile); } catch { /* en iyi çaba */ }
  switch (ack.status) {
    case "invalid": throw new Error(ack.reason === "key_disabled" ? "mod belirteci etkin değil: önce vlad mode token" : `geçersiz işlem/argüman: ${ack.reason ?? "reddedildi"}`);
    case "locked": throw new Error("kilitli: 3 ret/süre dolumu");
    case "busy": throw new Error(`meşgul: bekleyen istek var (${typeof ack.id === "string" ? ack.id.slice(0, 8) : "?"})`);
    case "rate_limited": throw new Error(`hız sınırı: ${ack.reason ?? "soğuma ya da saatlik/günlük kota"}`);
  }
  const id = ack.id;
  if (typeof id !== "string" || !NAME_RE.id.test(id) || typeof ack.expiresAt !== "string") throw new Error("approver yanıtı geçersiz");
  if (waitMs === null) return { data: { id, status: "pending", expiresAt: ack.expiresAt }, text: `onay isteği gönderildi (kimlik ${id.slice(0, 8)}, geçerli: ${ack.expiresAt}); telefondan onaylayın`, exit: 0 };

  const resultFile = join(dir, "results", `${id}.json`), limit = now() + waitMs;
  for (;;) {
    const r = readJsonFile(resultFile, LIMITS.maxOutputBytes * 2 + 4096) as ResultRecord | null;
    if (r) {
      if (typeof r !== "object" || r.id !== id || !RESULT_STATUS.includes(r.status)) throw new Error("approver sonuç kaydı geçersiz");
      const data: Record<string, unknown> = { id, status: r.status, exitCode: r.exitCode, ...(r.reason ? { reason: r.reason } : {}) };
      return { data, text: `${r.status}${r.reason ? `: ${r.reason}` : ""} (kimlik ${id.slice(0, 8)})`, exit: r.status === "done" ? 0 : 1 };
    }
    if (now() >= limit) return { data: { status: "wait_timeout", id }, text: `sonuç beklenirken süre doldu (kimlik ${id.slice(0, 8)}); istek iptal edilmedi: vlad approver show ${id}`, exit: 1 };
    await sleep(pollMs);
  }
}

// --- approver komutları ---
interface Cx { k: Kit; deps: ApproverCliDeps }
/** Gizli çıktı akışı: enjekte `stdout`; yoksa (yalnız testte `isTTY` enjeksiyonu varsa) kitin çıktı akışı; üretimde process.stdout. */
const stdoutOf = (cx: Cx): { isTTY?: boolean; write(s: string): unknown } => {
  if (cx.deps.stdout) return cx.deps.stdout;
  if (cx.deps.isTTY) { const w = cx.k.ctx.stdout; return { isTTY: cx.deps.isTTY(), write: (s) => w.write(s) }; }
  return process.stdout;
};
const randomOf = (cx: Cx) => cx.deps.random ?? realRandom;
const nowOf = (cx: Cx) => (cx.deps.now ?? (() => new Date()))();

async function installerOf(cx: Cx): Promise<ServiceInstaller> {
  return cx.deps.installer ?? (await import("../../approver/launchd.js")).createLaunchdInstaller();
}

/** Çalışan reddi + TTY + mod yetkisi (install/uninstall/rotate/unlock). */
function guardPrivileged(cx: Cx, what: string): void {
  assertNotWorker();
  if (!(cx.deps.isTTY ?? (() => process.stdin.isTTY === true))()) throw new Error(`approver ${what} yalnız etkileşimli terminalde (TTY) çalışır`);
  requireModeAuthority();
}

function openStore(cx: Cx): Store { return createStore(approverDir(), { now: () => nowOf(cx) }); }
function storeIfExists(cx: Cx): Store | null {
  try { lstatSync(approverDir()); } catch (e) { if (errno(e, "ENOENT")) return null; throw e; }
  return openStore(cx);
}
function channelOrThrow(store: Store): ChannelConfig {
  const c = store.readChannel();
  if (!c) throw new Error("approver kurulu değil: önce terminalde vlad approver install");
  return c;
}
function installCtx(cx: Cx) {
  let cli = cx.k.ctx.cliPath;
  try { cli = realpathSync(cli); } catch { /* yol çözülemezse olduğu gibi */ }
  return { node: process.execPath, cli, home: getVladHome(), path: process.env.PATH ?? "" };
}
const subscriptionUrl = (c: ChannelConfig): string => `${c.server.replace(/\/$/, "")}/${c.requestTopic}`;
/** Gizli URL: yalnız stdout TTY ise ve --json yokken; kitin `out`'u kullanılmaz. */
function printSecretUrl(cx: Cx, o: Opts, c: ChannelConfig): void {
  const so = stdoutOf(cx);
  if (o.json || !so.isTTY) return;
  so.write(`abonelik URL'si (gizli; paylaşma, ntfy uygulamasında bu konuya abone ol):\n${subscriptionUrl(c)}\n`);
}
const writeChannel = (dir: string, c: ChannelConfig): void => writeAtomic(join(dir, "channel.json"), JSON.stringify(c), { overwrite: true });

async function install(o: Opts, cx: Cx): Promise<void> {
  guardPrivileged(cx, "install");
  let server: string;
  try {
    const u = new URL(typeof o.server === "string" ? o.server : DEFAULT_SERVER);
    if (u.protocol !== "https:") throw new Error("https değil");
    server = u.origin;
  } catch { throw new Error("--server geçerli bir https adresi olmalı"); }
  if (keyState() !== "ok") throw new Error("mod belirteci etkin değil: önce vlad mode token");
  if (!o.json && !stdoutOf(cx).isTTY) throw new Error("abonelik URL'si yalnız terminale (stdout TTY) basılır; stdout bir terminal değil (kurulum yapılmadı)");

  const dir = approverDir();
  assertSecureDir(dir);
  const store = createStore(dir);
  const prev = store.readChannel();
  const channel: ChannelConfig = { v: 1, server, requestTopic: prev?.requestTopic ?? newTopic("vlad-q-", randomOf(cx)), createdAt: prev?.createdAt ?? nowOf(cx).toISOString() };
  writeChannel(dir, channel);
  let steps: string[];
  try { steps = await (await installerOf(cx)).install(installCtx(cx)); } catch (e) {
    if (prev) writeChannel(dir, prev); else { try { unlinkSync(join(dir, "channel.json")); } catch { /* yok */ } }
    throw e;
  }
  cx.k.out(o, { installed: true, steps }, ["approver kuruldu:", ...steps.map((s) => `  ${s}`)].join("\n"));
  printSecretUrl(cx, o, channel);
}

async function uninstall(o: Opts, cx: Cx): Promise<void> {
  guardPrivileged(cx, "uninstall");
  const steps = await (await installerOf(cx)).uninstall();
  rmSync(approverDir(), { recursive: true, force: true }); // used/ ve mode.key approver/ dışındadır
  steps.push("approver/ silindi");
  cx.k.out(o, { uninstalled: true, steps }, ["approver kaldırıldı:", ...steps.map((s) => `  ${s}`)].join("\n"));
}

async function rotate(o: Opts, cx: Cx): Promise<void> {
  guardPrivileged(cx, "rotate");
  const store = openStore(cx);
  const channel: ChannelConfig = { ...channelOrThrow(store), requestTopic: newTopic("vlad-q-", randomOf(cx)) };
  writeChannel(approverDir(), channel);
  let rejected: string | null = null;
  const p = store.readPending();
  if (p && p.status === "pending") {
    store.writeResult({ v: 1, id: p.id, status: "denied", exitCode: null, stdout: "", stderr: "", reason: "rotated", finishedAt: nowOf(cx).toISOString() });
    store.clearPending();
    rejected = p.shortId;
  }
  const installer = await installerOf(cx);
  if ((await installer.status()).installed) await installer.install(installCtx(cx)); // servis yeni konuyu yalnız yeniden başlayınca okur
  cx.k.out(o, { rotated: true, rejected }, `yeni istek konusu üretildi${rejected ? `; bekleyen istek reddedildi (${rejected})` : ""}; servis yeniden başlatıldı`);
  printSecretUrl(cx, o, channel);
}

function unlock(o: Opts, cx: Cx): void {
  guardPrivileged(cx, "unlock");
  const store = openStore(cx);
  channelOrThrow(store);
  let rate;
  try { rate = store.readRate(); } catch { rate = { v: 1 as const, decisions: [], consecutiveDenied: 0, lockedUntil: null }; } // bozuk durum: kurtarma yolu
  store.writeRate({ ...rate, consecutiveDenied: 0, lockedUntil: null });
  cx.k.out(o, { unlocked: true }, "kilit açıldı");
}

async function status(o: Opts, cx: Cx): Promise<void> {
  assertNotWorker();
  const svc = await (await installerOf(cx)).status();
  let pending: string | null = null, locked: string | null = null, store: Store | null = null;
  try { store = storeIfExists(cx); } catch { /* okunamayan dizin: aşağıda bozuk */ }
  if (store) {
    try { const p = store.readPending(); pending = p ? p.shortId : null; } catch { pending = "bozuk"; }
    try { const r = store.readRate(); if (r.lockedUntil && Date.parse(r.lockedUntil) > nowOf(cx).getTime()) locked = r.lockedUntil; } catch { locked = "rate_state_corrupt"; }
  }
  const data = { installed: svc.installed, running: svc.running, detail: svc.detail, pending, locked };
  cx.k.out(o, data, [`kurulu: ${svc.installed ? "evet" : "hayır"}`, `çalışıyor: ${svc.running ? "evet" : "hayır"} (${svc.detail})`, `bekleyen: ${pending ?? "yok"}`, `kilit: ${locked ?? "yok"}`].join("\n"));
}

function requests(o: Opts, cx: Cx): void {
  assertNotWorker();
  const limit = o.limit === undefined ? 20 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit pozitif tam sayı olmalı");
  const store = storeIfExists(cx);
  const rows: Array<Record<string, unknown>> = [];
  const p = store?.readPending();
  if (p) rows.push({ id: p.id, shortId: p.shortId, status: p.status, op: p.op, requestedAt: p.requestedAt, expiresAt: p.expiresAt });
  for (const r of store?.listResults(limit) ?? []) rows.push({ id: r.id, status: r.status, exitCode: r.exitCode, ...(r.reason ? { reason: r.reason } : {}), finishedAt: r.finishedAt });
  const shown = rows.slice(0, limit);
  cx.k.out(o, { requests: shown }, shown.length ? shown.map((r) => `${String(r.id).slice(0, 8)}  ${r.status}${r.reason ? ` (${r.reason})` : ""}  ${r.op ?? r.finishedAt}`).join("\n") : "kayıt yok");
}

const clip = (s: string): string => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
function show(id: string, o: Opts, cx: Cx): void {
  assertNotWorker();
  if (!NAME_RE.id.test(id)) throw new Error("geçersiz kimlik (26 karakter base32 beklenir)");
  const store = storeIfExists(cx);
  const p = store?.readPending();
  const pending = p && p.id === id ? { status: p.status, op: p.op, argv: p.argv.map(clip), requester: p.requester, requestedAt: p.requestedAt, expiresAt: p.expiresAt } : null;
  const r = store?.readResult(id) ?? null;
  // Sonuç kaydı op/argv/requester taşıyorsa (servis settle'da yazar) bekleyen kayıt silindikten sonra da gösterilir; değerler 60 karakterde kırpılı.
  const rx = r as (ResultRecord & { op?: unknown; argv?: unknown; requester?: unknown }) | null;
  const origin = !pending && rx && typeof rx.op === "string" ? { op: rx.op, argv: Array.isArray(rx.argv) ? rx.argv.map((a) => clip(String(a))) : [], requester: typeof rx.requester === "string" ? clip(rx.requester) : "?" } : null;
  const result = r ? { status: r.status, exitCode: r.exitCode, ...(r.reason ? { reason: r.reason } : {}), finishedAt: r.finishedAt, ...(origin ?? {}) } : null;
  if (!pending && !result) throw new Error(`kayıt bulunamadı: ${id}`);
  const lines = [`kimlik: ${id}`];
  if (pending) lines.push(`işlem: ${pending.op} ${pending.argv.join(" ")}`, `isteyen: ${pending.requester} (beyan, doğrulanmamış)`, `durum: ${pending.status}`, `geçerli: ${pending.expiresAt}`);
  if (origin) lines.push(`işlem: ${origin.op} ${origin.argv.join(" ")}`, `isteyen: ${origin.requester} (beyan, doğrulanmamış)`);
  if (result) lines.push(`sonuç: ${result.status}${result.reason ? ` (${result.reason})` : ""}, çıkış ${result.exitCode ?? "-"}, ${result.finishedAt}`);
  cx.k.out(o, { id, pending, result }, lines.join("\n"));
}

async function run(_o: Opts, cx: Cx): Promise<void> {
  assertNotWorker();
  const store = openStore(cx);
  const channel = new NtfyChannel(channelOrThrow(store));
  const ac = new AbortController();
  const stop = (): void => ac.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    await runApprover({ channel, clock: { now: () => new Date() }, random: randomOf(cx), executor: createExecutor(), store, log: (l) => store.log(l), signal: ac.signal });
  } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

export function registerApprover(program: Command, k: Kit, deps: ApproverCliDeps = {}): void {
  const { def } = k;
  const cx: Cx = { k, deps };
  const approver = program.command("approver").description("Uzaktan onay servisi (telefondan onay; yalnız macOS launchd)");
  def(approver, "install", "Servisi kurar: channel.json + launchd plist; gizli abonelik URL'sini yalnız TTY'ye basar (terminalde, mod yetkisiyle)", (o: Opts) => install(o, cx))
    .option("--server <url>", "ntfy sunucusu (https zorunlu; varsayılan https://ntfy.sh)");
  def(approver, "uninstall", "Servisi durdurur, plist'i ve approver/ altını siler (used/ ve mode.key'e dokunmaz)", (o: Opts) => uninstall(o, cx));
  def(approver, "rotate", "Yeni gizli istek konusu üretir, bekleyen isteği reddeder, yeni abonelik URL'sini TTY'ye basar", (o: Opts) => rotate(o, cx));
  def(approver, "unlock", "3 art arda ret/süre dolumu kilidini açar (TTY + mod yetkisi)", (o: Opts) => unlock(o, cx));
  def(approver, "status", "Servis durumu (salt okuma; konu/nonce/tag göstermez)", (o: Opts) => status(o, cx));
  def(approver, "requests", "Son istekleri listeler (salt okuma)", (o: Opts) => requests(o, cx))
    .option("--limit <n>", "en çok kaç kayıt");
  def(approver, "show <id>", "Tek isteğin ayrıntısı (salt okuma)", (id: string, o: Opts) => show(id, o, cx));
  def(approver, "run", "Servis girişi (launchd girişi; elle çalıştırılmaz)", (o: Opts) => run(o, cx));
}
