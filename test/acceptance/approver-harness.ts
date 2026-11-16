// Uzaktan onay KABUL harness'i (T20261116-05). Yalnız spec/plan/sözleşmeden yazıldı; uygulamanın içine bakılmadı.
// Gerçek kaynak koruması: gizli dizin (`setSecretDirForTests`), VLAD_HOME, saat, rastgelelik, yürütücü ve ntfy HEP sahte/geçici.
// `http.createServer` YALNIZ test kodunda (sahte ntfy, loopback); üretim kodunda dinleyen soket yasaktır (test/arch/approver-no-listen).
import { isolatedEnv } from "../support/spawn-vlad.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Command } from "commander";
import { createKit } from "../../src/cli/kit.js";
import { failWith, handleParseError } from "../../src/cli/ctx.js";
import type { CliCtx } from "../../src/cli/ctx.js";
import { registerApprover } from "../../src/cli/groups/approver.js";
import type { ApproverCliDeps } from "../../src/cli/groups/approver.js";
import { buildProgram } from "../../src/cli/program.js";
import { assertSecureDir, readSecureFile, writeAtomic } from "../../src/mode/secure-fs.js";
import { approverDir, initKey, readKey, secretDir, setSecretDirForTests } from "../../src/mode/token.js";
import { NtfyChannel } from "../../src/approver/ntfy.js";
import { runApprover } from "../../src/approver/service.js";
import type { ApproverDeps, Clock } from "../../src/approver/service.js";
import type { Executor } from "../../src/approver/exec.js";
import type { RandomSource } from "../../src/approver/request.js";
import { createStore } from "../../src/approver/store.js";
import type { Store } from "../../src/approver/store.js";
import type { AckRecord, ChannelConfig, Ctx, Op, PendingRecord, ResultRecord } from "../../src/approver/types.js";
import { makeHome } from "../helpers.js";
import { Writable } from "node:stream";

// ---------------------------------------------------------------- küçük yardımcılar
/** Gerçek zamanlı bekleme (servis döngüsü gerçek zamanda döner; saat sahtedir). Koşul sağlanmazsa fırlatır. */
export async function waitFor<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 8000, step = 15): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    let v: T | undefined | null | false;
    try { v = await fn(); } catch { v = undefined; }
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`zaman aşımı: ${what} (${ms} ms)`);
    await new Promise((r) => setTimeout(r, step));
  }
}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function b32(bytes: Buffer, len = 26): string {
  let bits = 0, acc = 0, out = "";
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5 && out.length < len) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.padEnd(len, "a").slice(0, len);
}
let cidSeq = 0;
/** Geçerli `^[a-z2-7]{26}$` istemci kimliği (test içi benzersiz). */
export const makeCid = (): string => b32(createHash("sha256").update(`cid-${process.pid}-${++cidSeq}-${Date.now()}`).digest());

/** Sahte saat: `new Date()` ile BAŞLAR (göreli), `advance` ile ilerler/geri gider. */
export class FakeClock implements Clock {
  private t = Date.now();
  now(): Date { return new Date(this.t); }
  advance(ms: number): void { this.t += ms; }
}
/** Deterministik rastgelelik (her çağrıda farklı baytlar). */
export class SeededRandom implements RandomSource {
  private n = 0;
  constructor(private readonly seed = "seed") {}
  bytes(len: number): Buffer {
    const out: Buffer[] = [];
    let have = 0;
    while (have < len) { const h = createHash("sha256").update(`${this.seed}|${++this.n}`).digest(); out.push(h); have += h.length; }
    return Buffer.concat(out).subarray(0, len);
  }
}

/** Plandaki digest formülü (uygulamadan bağımsız; test/fixtures/approver/golden-digest.json ile aynı). */
export const digestOf = (p: { id: string; argv: string[]; requestedAt: string; expiresAt: string; nonce: string; requester: string; ctx: Ctx }): string =>
  createHash("sha256").update(JSON.stringify(["VLAD-APPROVE1", p.id, p.argv, p.requestedAt, p.expiresAt, p.nonce, p.requester, p.ctx.home, p.ctx.kb, p.ctx.cli])).digest("hex");

// ---------------------------------------------------------------- sahte yürütücü
export interface ExecCall { argv: string[]; token: string; ctx: Ctx; envExtra?: Record<string, string> }
export class FakeExecutor implements Executor {
  calls: ExecCall[] = [];
  reply: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean } = { exitCode: 0, stdout: "tamam", stderr: "", timedOut: false };
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  /** Sonraki çağrıları `release()`e kadar tut (yürütme sırasında durum gözlemi için). */
  hold(): void { this.gate = new Promise<void>((r) => { this.open = r; }); }
  release(): void { this.open?.(); this.gate = null; }
  async run(argv: string[], token: string, ctx: Ctx, deps?: { envExtra?: Record<string, string> }) {
    this.calls.push({ argv: [...argv], token, ctx, envExtra: deps?.envExtra });
    if (this.gate) await this.gate;
    return this.reply;
  }
}

// ---------------------------------------------------------------- sahte ntfy (loopback; YALNIZ test)
export interface PublishedMsg { topic: string; title: string; message: string; actions: Array<{ action: string; label: string; url: string; method: string; body: string; clear?: boolean }>; raw: Record<string, unknown> }
export class FakeNtfyServer {
  published: PublishedMsg[] = [];
  /** Telefondan gelen düğme POST'ları (konu → gövde). */
  posts: Array<{ topic: string; body: string }> = [];
  connections: Array<{ topic: string; since: string | null; at: number }> = [];
  /** Sıradaki yayın isteklerine verilecek durum kodları (ör. 500, 429). */
  failPublish: Array<{ status: number; retryAfter?: number }> = [];
  /** Sıradaki akış bağlantılarına verilecek durum kodları. */
  failStream: Array<{ status: number; retryAfter?: number }> = [];
  holdOpen = false;
  url = "";
  private streams = new Set<{ topic: string; res: ServerResponse }>();
  private held: Array<() => void> = [];
  private seq = 0;
  readonly lastEventId = (): string | null => (this.seq ? `m${this.seq}` : null);
  private readonly server = http.createServer((req, res) => this.handle(req, res));
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const a = this.server.address();
    this.url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  }
  async stop(): Promise<void> {
    for (const s of this.streams) s.res.destroy();
    this.streams.clear();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  private handle(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url ?? "/", this.url || "http://x");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method === "POST" && u.pathname === "/") {
        const f = this.failPublish.shift();
        if (f) { res.writeHead(f.status, f.retryAfter ? { "Retry-After": String(f.retryAfter) } : {}); res.end("hata"); return; }
        let j: Record<string, unknown> = {};
        try { j = JSON.parse(body); } catch { res.writeHead(400); res.end("{}"); return; }
        this.published.push({ topic: String(j.topic), title: String(j.title ?? ""), message: String(j.message ?? ""), actions: (j.actions as PublishedMsg["actions"]) ?? [], raw: j });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `p${this.published.length}`, time: Math.floor(Date.now() / 1000), event: "message", topic: j.topic }));
        return;
      }
      if (req.method === "GET" && u.pathname.endsWith("/json")) {
        const topic = u.pathname.slice(1, -"/json".length);
        this.connections.push({ topic, since: u.searchParams.get("since"), at: Date.now() });
        const f = this.failStream.shift();
        if (f) { res.writeHead(f.status, f.retryAfter ? { "Retry-After": String(f.retryAfter) } : {}); res.end(); return; }
        const open = (): void => {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.write(JSON.stringify({ id: `o${this.connections.length}`, time: Math.floor(Date.now() / 1000), event: "open", topic }) + "\n");
          this.streams.add({ topic, res });
        };
        res.on("close", () => { for (const s of this.streams) if (s.res === res) this.streams.delete(s); });
        if (this.holdOpen) this.held.push(open); else open();
        return;
      }
      if (req.method === "POST") { // telefon düğmesi: ntfy'deki gibi aynı konudaki abonelere `message` olarak yayılır
        const topic = u.pathname.slice(1);
        this.posts.push({ topic, body });
        this.emit(topic, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404); res.end();
    });
  }
  releaseOpen(): void { this.holdOpen = false; for (const o of this.held.splice(0)) o(); }
  streamCount(topic?: string): number { let n = 0; for (const s of this.streams) if (!topic || s.topic === topic) n++; return n; }
  /** Bir `message` olayı satırı (NDJSON). */
  line(topic: string, body: string): string {
    return JSON.stringify({ id: `m${++this.seq}`, time: Math.floor(Date.now() / 1000), expires: Math.floor(Date.now() / 1000) + 43_200, event: "message", topic, message: body }) + "\n";
  }
  /** Ham yazım (tek chunk'ta birden çok satır, parçalı baytlar vb. için). */
  writeRaw(topic: string, data: string | Buffer): void { for (const s of this.streams) if (s.topic === topic) s.res.write(data); }
  emit(topic: string, body: string): void { this.writeRaw(topic, this.line(topic, body)); }
  dropStreams(): void { for (const s of this.streams) s.res.destroy(); this.streams.clear(); }
  /** Telefonda düğmeye basmak: eylemin URL'sine gövdesini POST eder. */
  async press(msg: PublishedMsg, label: "Onayla" | "Reddet"): Promise<string> {
    const a = msg.actions.find((x) => x.label === label);
    if (!a) throw new Error(`bildirimde '${label}' düğmesi yok`);
    const r = await fetch(a.url, { method: a.method, body: a.body });
    await r.arrayBuffer();
    return a.body;
  }
}

// ---------------------------------------------------------------- dünya
export interface World {
  root: string; vladHome: string; secret: string; key: string;
  /** Gerçek Store (U2) tembel kurulur: stub'ta makeWorld yine açılır. */
  dir: string; readonly store: Store; clock: FakeClock; random: SeededRandom; exec: FakeExecutor; ntfy: FakeNtfyServer; cfg: ChannelConfig; channel: NtfyChannel;
  logs: string[];
  services: Service[];
  dispose(): Promise<void>;
}
export interface Service { stop(): Promise<void>; settled(): boolean; error(): Error | null; ac: AbortController }

/** Geçici kök altında: gizli dizin (anahtar etkin), VLAD_HOME, sahte ntfy, gerçek Store (`createStore`). */
export async function makeWorld(): Promise<World> {
  const root = realpathSync(join(realpathSync(tmpdir()), "")) + sep + `vlad-approver-kabul-${process.pid}-${Date.now()}-${++cidSeq}`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const prevSecret = secretDir();
  const prevHome = process.env.VLAD_HOME;
  const vladHome = realpathSync(makeHome()); // VLAD_HOME'u da ayarlar; test dosyası bitince temizlenir
  const secret = join(root, "secret");
  setSecretDirForTests(secret);
  initKey();
  const key = readKey() as string;
  assertSecureDir(approverDir());
  const ntfy = new FakeNtfyServer();
  await ntfy.start();
  const cfg: ChannelConfig = { v: 1, server: ntfy.url, requestTopic: "vlad-q-" + b32(createHash("sha256").update(root).digest()), createdAt: new Date().toISOString() };
  writeAtomic(join(approverDir(), "channel.json"), JSON.stringify(cfg), { overwrite: true });
  let storeCache: Store | undefined;
  const w: World = {
    root, vladHome, secret, key, dir: approverDir(), get store() { return (storeCache ??= createStore(approverDir())); }, clock: new FakeClock(), random: new SeededRandom(root), exec: new FakeExecutor(), ntfy, cfg,
    channel: new NtfyChannel(cfg), logs: [], services: [],
    async dispose() {
      for (const s of w.services) await s.stop().catch(() => undefined);
      await ntfy.stop();
      setSecretDirForTests(prevSecret);
      if (prevHome === undefined) delete process.env.VLAD_HOME; else process.env.VLAD_HOME = prevHome;
      // silmeden önce hedefin gerçekten geçici dizin olduğunu doğrula
      const real = realpathSync(root);
      if (!real.startsWith(realpathSync(tmpdir()) + sep) || !real.includes("vlad-approver-kabul-")) throw new Error(`güvenli olmayan silme hedefi: ${real}`);
      rmSync(real, { recursive: true, force: true });
      rmSync(`${secret}.active`, { force: true });
    },
  };
  return w;
}

/** `runApprover(deps)`'i arka planda başlatır; `over` ile saat/depo/kanal vb. değiştirilebilir (ör. arızalı Store). */
export function startService(w: World, over: Partial<ApproverDeps> = {}): Service {
  const ac = new AbortController();
  const deps: ApproverDeps = { channel: w.channel, clock: w.clock, random: w.random, executor: w.exec, store: w.store, log: (l) => { w.logs.push(l); }, signal: ac.signal, ...over };
  let err: Error | null = null, done = false;
  const p = Promise.resolve().then(() => runApprover(deps)).then(() => { done = true; }, (e: unknown) => { err = e as Error; done = true; });
  const s: Service = { ac, stop: async () => { ac.abort(); await p; }, settled: () => done, error: () => err };
  w.services.push(s);
  return s;
}

/** Servisin bağlandığını (yanıt akışı açık) bekler. */
export const untilWatching = (w: World, ms = 8000): Promise<void> => waitFor(() => w.ntfy.streamCount() > 0, "servis yanıt akışına bağlandı", ms).then(() => undefined);

export function opOf(argv: string[]): Op {
  return (argv[0] === "mode" ? `mode ${argv[1]}` : argv[0]) as Op;
}
/** İstemcinin yaptığı gibi `inbox/<cid>.json` yazar (atomik, 0600, üzerine yazma yok). */
export function writeRequest(w: World, o: { argv: string[]; requester?: string; cid?: string; extra?: Record<string, unknown>; requestedAt?: string }): string {
  const cid = o.cid ?? makeCid();
  assertSecureDir(join(w.dir, "inbox"));
  const file = { v: 1, cid, op: opOf(o.argv), argv: o.argv, requestedAt: o.requestedAt ?? w.clock.now().toISOString(), requester: o.requester ?? "vlad-07", ...(o.extra ?? {}) };
  writeAtomic(join(w.dir, "inbox", `${cid}.json`), JSON.stringify(file), { overwrite: false });
  return cid;
}
export async function waitAck(w: World, cid: string, ms = 8000): Promise<AckRecord> {
  return waitFor(() => JSON.parse(readSecureFile(join(w.dir, "ack", `${cid}.json`), 8192).toString("utf8")) as AckRecord, `ack ${cid}`, ms);
}
/** İstek yazar, ack'i bekler; `pending` ise bildirimin yayınlanmasını da bekler. */
export async function submit(w: World, argv: string[], o: { requester?: string; extra?: Record<string, unknown> } = {}): Promise<{ cid: string; ack: AckRecord; pending: PendingRecord | null; msg: PublishedMsg | null }> {
  const before = w.ntfy.published.length;
  const cid = writeRequest(w, { argv, ...o });
  const ack = await waitAck(w, cid);
  if (ack.status !== "pending") return { cid, ack, pending: null, msg: null };
  const msg = await waitFor(() => w.ntfy.published.length > before && w.ntfy.published[before], "istek bildirimi yayınlandı");
  const pending = w.store.readPending();
  return { cid, ack, pending, msg };
}
export const resultOf = (w: World, id: string, ms = 8000): Promise<ResultRecord> => waitFor(() => w.store.readResult(id), `sonuç ${id}`, ms);
/** approver.log (+ döndürülmüş .1) ve deps.log satırları. */
export function logText(w: World): string {
  const parts = [...w.logs];
  for (const n of ["approver.log", "approver.log.1"]) { const f = join(w.dir, n); if (existsSync(f)) parts.push(readFileSync(f, "utf8")); }
  return parts.join("\n");
}
export const dirFiles = (d: string): string[] => (existsSync(d) ? readdirSync(d) : []);

// ---------------------------------------------------------------- CLI (süreç içi)
export interface CliRun { code: number; out: string; err: string }
class ExitSignal extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const sink = () => { const c: string[] = []; return { w: new Writable({ write(ch, _e, cb) { c.push(String(ch)); cb(); } }), text: () => c.join("") }; };

/**
 * `vlad <args>` süreç içinde. `approverDeps` verilirse yalnız `approver` grubu (TTY enjeksiyonu için) kaydedilir; aksi halde tüm program.
 * `env` çağrı süresince process.env'e uygulanıp geri alınır (çağrılar çakışmamalı). cwd değişmez: çağıran nötr dizine geçmiş olmalı
 * (mode komutları `vlad/T…` dalındaki cwd'yi çalışan sayar).
 */
export async function runVlad(args: string[], o: { env?: Record<string, string | undefined>; approverDeps?: ApproverCliDeps } = {}): Promise<CliRun> {
  const out = sink(), err = sink();
  const defined: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env ?? {})) if (v !== undefined) defined[k] = v;
  const env: Record<string, string | undefined> = isolatedEnv(defined);
  for (const [k, v] of Object.entries(o.env ?? {})) if (v === undefined) delete env[k];
  const ctx: CliCtx = { cliPath: "vlad", argv: ["node", "vlad", ...args], stdout: out.w, stderr: err.w, exit: (c) => { throw new ExitSignal(c); }, env: env as NodeJS.ProcessEnv };
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(o.env ?? {})) { saved.set(k, process.env[k]); if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  let code = 0;
  try {
    let program: Command;
    if (o.approverDeps) {
      program = new Command().name("vlad").exitOverride().configureOutput({ writeErr: () => undefined });
      registerApprover(program, createKit(ctx), o.approverDeps);
    } else program = buildProgram(ctx);
    try { await program.parseAsync(ctx.argv); } catch (e) { if (e instanceof ExitSignal) throw e; if (o.approverDeps) failWith(ctx, e); else handleParseError(program, ctx, e); }
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code; else throw e;
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return { code, out: out.text(), err: err.text() };
}

export const ALLOWED_EXEC_ENV = ["PATH", "HOME", "VLAD_HOME", "LANG", "VLAD_MODE_TOKEN"] as const;
