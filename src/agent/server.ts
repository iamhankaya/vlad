import { createHash } from "node:crypto";
import net from "node:net";
import type { VladConfig } from "../kb/types.js";
import { nowMs } from "../machines/clock.js";
import { CLOCK_SKEW_MS, MAX_CONNECTIONS, PROTO_VERSION, RemoteError, type AgentCode, type AgentOp, type AgentRequest, type AgentResponse, type OpMeta, type WireCode } from "../machines/types.js";
import { FrameDecoder, encodeFrame } from "./frame.js";
import type { Journal } from "./journal.js";
import { isAllowed, type AgentKind, type CallerRole, type OpHandler } from "./ops/index.js";
import { canonicalJson, signResponse, verifyRequest } from "./sign.js";
import { roleOf } from "./state.js";

type WireResponse = AgentResponse & { meta?: OpMeta };

export interface ServerOpts {
  self: string;
  kind: AgentKind;
  cfg: () => VladConfig;
  keys: Record<string, string>;
  ops: Record<AgentOp, OpHandler>;
  journal: Journal;
  build: string;
  bind: string;
  port: number;
  readTimeoutMs?: number;
  maxConnections?: number;
  /** Yan etkili (günlüğe girer) işlem mi? Varsayılan: salt okunurlar hariç hepsi. */
  journaled?: (op: AgentOp, args: unknown) => boolean;
  /** Yalnız VLAD_AGENT_TEST=1: after-started | after-apply | before-done → process.exit(137). */
  crashAt?: string;
}

const READ_ONLY: ReadonlySet<AgentOp> = new Set<AgentOp>(["ping", "op-status", "kb-head", "queue-list", "queue-flush", "liveness", "probe-window", "merge-preview", "gate-run", "forward-write", "queue-drop"]);
const defaultJournaled = (op: AgentOp): boolean => !READ_ONLY.has(op);

const hashArgs = (a: unknown) => createHash("sha256").update(canonicalJson(a), "utf8").digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

export function callerRole(cfg: VladConfig, self: string, from: string): CallerRole | null {
  if (from === self) return "self";
  return roleOf(cfg, from);
}

class Fail extends Error {
  constructor(public code: WireCode, msg: string, public signed = true) { super(msg); }
}

/** Tek isteği doğrular, yetkilendirir ve çalıştırır. Sıra: biçim → kimlik(HMAC) → saat → sürüm → hedef → rol/op → günlük → işlem. */
export async function handleRequest(o: ServerOpts, raw: unknown): Promise<WireResponse> {
  const serverTs = nowMs();
  const base = { v: PROTO_VERSION, serverTs, build: o.build };
  const reply = (opId: string, code: WireCode, o2: { result?: unknown; error?: string; key?: string; meta?: OpMeta }): WireResponse => {
    const r = { ...base, opId, ok: code === "ok", code, ...(o2.result !== undefined ? { result: o2.result } : {}), ...(o2.error ? { error: o2.error } : {}) };
    const signed = o2.key ? signResponse(o2.key, r) : { ...r, sig: "" };
    return o2.meta ? { ...signed, meta: o2.meta } : signed;
  };
  const r = raw as Partial<AgentRequest> | null;
  if (!r || typeof r !== "object" || typeof r.from !== "string" || typeof r.to !== "string" || typeof r.opId !== "string" || typeof r.op !== "string" || typeof r.ts !== "number" || typeof r.sig !== "string") {
    return reply(typeof r?.opId === "string" ? r.opId : "", "bad_request", { error: "bad_request: istek biçimi geçersiz" });
  }
  const req = r as AgentRequest;
  const key = o.keys[req.from];
  if (!key || req.to !== o.self || !verifyRequest(key, req)) return reply(req.opId, "auth", { error: "auth: imza geçersiz" });
  const sign = (code: WireCode, x: { result?: unknown; error?: string; meta?: OpMeta } = {}) => reply(req.opId, code, { ...x, key });
  try {
    if (Math.abs(serverTs - req.ts) > CLOCK_SKEW_MS) throw new Fail("clock_skew", `clock_skew: saat farkı çok büyük (sunucu ${iso(serverTs)}, istemci ${iso(req.ts)})`);
    if (req.v !== PROTO_VERSION && req.op !== "ping") throw new Fail("proto_mismatch", `proto_mismatch: protokol ${req.v} ≠ ${PROTO_VERSION}`);
    const role = callerRole(o.cfg(), o.self, req.from);
    if (!role || !isAllowed(o.kind, role, req.op)) throw new Fail("forbidden", `forbidden: ${req.op} bu kimlikten çalıştırılamaz`);
    const handler = o.ops[req.op];
    if (!handler) throw new Fail("bad_request", `bad_request: bilinmeyen işlem: ${req.op}`);
    const ctx = { from: req.from, opId: req.opId };
    if (!(o.journaled ?? defaultJournaled)(req.op, req.args)) return sign("ok", { result: await handler(req.args, ctx) });
    return await runJournaled(o, req, handler, sign);
  } catch (e) {
    const f = toFail(e);
    return f.signed ? sign(f.code, { error: f.message }) : reply(req.opId, f.code, { error: f.message });
  }
}

function toFail(e: unknown): Fail {
  if (e instanceof Fail) return e;
  if (e instanceof RemoteError) return new Fail(wire(e.code), e.message);
  return new Fail("failed", `failed: ${(e as Error).message}`);
}
const wire = (c: AgentCode): WireCode => (c === "unreachable" || c === "timeout" ? "failed" : c);

/** Bu süreçte şu an çalışan opId'ler; günlükte `started` ama burada yoksa kalıntıdır (uzlaştırma bitirmedi). */
const running = new Set<string>();

async function runJournaled(o: ServerOpts, req: AgentRequest, handler: OpHandler, sign: (c: WireCode, x?: { result?: unknown; error?: string; meta?: OpMeta }) => WireResponse): Promise<WireResponse> {
  const j = o.journal;
  const hash = hashArgs(req.args);
  const crash = (at: string) => { if (o.crashAt === at) process.exit(137); };
  for (;;) {
    const rec = j.get(req.opId);
    if (!rec || rec.state === "aborted") break;
    if (rec.from !== req.from || (rec.argsHash && rec.argsHash !== hash)) throw new Fail("conflict", "conflict: opId başka bir istekle kullanılmış");
    if (rec.state === "aborted-cancelled") throw new Fail("conflict", "conflict: işlem iptal edilmiş");
    if (rec.state === "started" && !running.has(req.opId)) throw new Fail("conflict", "conflict: önceki deneme belirsiz kaldı; op-status ile sorgula");
    const done = rec.state === "started" ? await j.waitFor(req.opId) : rec;
    if (done.state === "done") return sign("ok", { ...(done.result !== undefined ? { result: done.result } : {}), meta: { ...done.meta, replayed: true } });
    // bekleyen işlem hata ile bitti (aborted): yeniden denenebilir
  }
  j.start(req.opId, req.from, req.op, hash);
  running.add(req.opId);
  crash("after-started");
  try {
    const result = await handler(req.args, { from: req.from, opId: req.opId });
    crash("after-apply");
    crash("before-done");
    j.finish(req.opId, "done", result ?? null);
    return sign("ok", { result: result ?? null });
  } catch (e) {
    j.finish(req.opId, "aborted");
    throw e;
  } finally { running.delete(req.opId); }
}

export interface RunningServer { host: string; port: number; close(): Promise<void> }

export function startServer(o: ServerOpts): Promise<RunningServer> {
  const max = o.maxConnections ?? MAX_CONNECTIONS;
  const socks = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    if (socks.size >= max) return void sock.destroy();
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    sock.on("error", () => sock.destroy());
    const dec = new FrameDecoder();
    let handled = false;
    const timer = setTimeout(() => sock.destroy(), o.readTimeoutMs ?? 10_000); // yarım çerçeve / slow-loris
    const respond = (r: WireResponse) => { clearTimeout(timer); sock.end(encodeFrame(r)); };
    sock.on("close", () => clearTimeout(timer));
    sock.on("data", (d: Buffer) => {
      if (handled) return;
      let frames: unknown[];
      try { frames = dec.push(d); } catch (e) {
        handled = true;
        const code = (e as RemoteError).code as WireCode;
        return respond({ v: PROTO_VERSION, opId: "", ok: false, code, error: (e as Error).message, serverTs: nowMs(), build: o.build, sig: "" });
      }
      if (!frames.length) return;
      handled = true;
      handleRequest(o, frames[0]).then(respond, () => sock.destroy());
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.bind, () => {
      const a = server.address() as net.AddressInfo;
      resolve({
        host: a.address, port: a.port,
        close: () => new Promise<void>((res) => { for (const s of socks) s.destroy(); server.close(() => res()); }),
      });
    });
  });
}
