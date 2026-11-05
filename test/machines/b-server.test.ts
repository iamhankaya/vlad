import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../../src/agent/client.js";
import { encodeFrame, FrameDecoder } from "../../src/agent/frame.js";
import { Journal } from "../../src/agent/journal.js";
import { setAgentEnv } from "../../src/agent/ops/env.js";
import { OP_TABLE, type OpHandler } from "../../src/agent/ops/index.js";
import { startServer, type RunningServer } from "../../src/agent/server.js";
import { signRequest } from "../../src/agent/sign.js";
import { assertPrivateBind } from "../../src/fleet/state.js";
import { defaultConfig } from "../../src/kb/config.js";
import type { VladConfig } from "../../src/kb/types.js";
import { MAX_FRAME_BYTES, RemoteError, type AgentOp, type AgentRequest } from "../../src/fleet/types.js";
import { rmTemp } from "../helpers.js";

// K: sunucunun (windows) anahtarları, KARŞI taraf adıyla (çift anahtar, D-vlad-057): K.mac = mac↔windows, K.desktop = desktop↔windows, K.windows = kendi.
const K = { mac: "11".repeat(32), windows: "22".repeat(32), desktop: "33".repeat(32) };
const cfg = (): VladConfig => ({
  ...defaultConfig(), brain: "mac", consoles: [{ name: "desktop" }],
  machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 1 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: 1 } }],
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); setAgentEnv(undefined); });

/** worker Agent'ı (self=windows) kurar; `ops` ile gövdeleri değiştirilebilir. */
async function worker(ops: Partial<Record<AgentOp, OpHandler>> = {}, o: { readTimeoutMs?: number; maxConnections?: number } = {}) {
  const c = cfg();
  const dir = mkdtempSync(join(tmpdir(), "vlad-srv-"));
  cleanups.push(() => rmTemp(dir));
  const journal = new Journal(join(dir, "j.jsonl"), () => Date.now());
  const client = new AgentClient({ self: "windows", keys: K, config: () => c });
  setAgentEnv({ self: "windows", kind: "worker-agent", cfg: c, startedAt: Date.now() - 5000, build: "t", journal, transport: client, now: () => Date.now() });
  const srv: RunningServer = await startServer({ self: "windows", kind: "worker-agent", cfg: () => c, keys: K, ops: { ...OP_TABLE, ...ops }, journal, build: "t", bind: "127.0.0.1", port: 0, ...o });
  cleanups.push(() => srv.close());
  c.machines![1]!.agent.port = srv.port;
  return { c, srv, journal, as: (self: string) => new AgentClient({ self, keys: { windows: K[self as keyof typeof K] }, config: () => c }) };
}

/** İmzalı ham istek gönderip tek yanıt çerçevesi okur. */
function raw(port: number, frame: Buffer | unknown, keepOpen = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    const d = new FrameDecoder();
    s.on("connect", () => s.write(Buffer.isBuffer(frame) ? frame : encodeFrame(frame)));
    s.on("data", (b) => { const [r] = d.push(b); if (r) { if (!keepOpen) s.destroy(); resolve(r); } });
    s.on("error", reject);
    s.on("close", () => resolve(null));
  });
}
const req = (o: Partial<AgentRequest> = {}) => signRequest(K.mac, { v: 1, from: "mac", to: "windows", opId: "op-" + Math.random(), ts: Date.now(), op: "ping", args: {}, ...o });

describe("machines:B server+client (loopback)", () => {
  it("ping returns the worker shape; brain caller allowed", async () => {
    const w = await worker();
    const { result } = await w.as("mac").call<any>("windows", "ping", {});
    expect(result).toMatchObject({ machine: "windows", os: process.platform, proto: 1, build: "t" });
    expect(result.uptimeS).toBeGreaterThanOrEqual(5);
  });
  it("wrong key, unknown sender and a request addressed to another machine are all `auth`", async () => {
    const w = await worker();
    expect((await raw(w.srv.port, signRequest("aa".repeat(32), { v: 1, from: "mac", to: "windows", opId: "x", ts: Date.now(), op: "ping", args: {} }))).code).toBe("auth");
    expect((await raw(w.srv.port, signRequest(K.mac, { v: 1, from: "ghost", to: "windows", opId: "x", ts: Date.now(), op: "ping", args: {} }))).code).toBe("auth");
    expect((await raw(w.srv.port, req({ to: "mac" }))).code).toBe("auth"); // başka uca yazılmış istek yansıtılamaz
  });
  it("changed args after signing is `auth`", async () => {
    const w = await worker();
    const r = req({ op: "op-status", args: { target: "a" } });
    expect((await raw(w.srv.port, { ...r, args: { target: "b" } })).code).toBe("auth");
  });
  it("stale ts → clock_skew with both clocks in the message (signed)", async () => {
    const w = await worker();
    const r = await raw(w.srv.port, req({ ts: Date.now() - 10 * 60_000 }));
    expect(r).toMatchObject({ ok: false, code: "clock_skew" });
    expect(r.error).toMatch(/^clock_skew: saat farkı çok büyük \(sunucu .+, istemci .+\)$/);
  });
  it("protocol mismatch blocks every op except ping", async () => {
    const w = await worker();
    expect((await raw(w.srv.port, req({ v: 2, op: "op-status", args: { target: "x" } }))).code).toBe("proto_mismatch");
    expect((await raw(w.srv.port, req({ v: 2 }))).code).toBe("ok");
  });
  it("role table: console and worker are forbidden on a worker agent; brain's forward-write too", async () => {
    const w = await worker();
    const e = await w.as("desktop").call("windows", "ping", {}).catch((x) => x);
    expect(e).toBeInstanceOf(RemoteError);
    expect(e).toMatchObject({ code: "forbidden", message: "forbidden: ping bu kimlikten çalıştırılamaz" });
    const f = await w.as("mac").call("windows", "queue-list", {}).catch((x) => x);
    expect(f.code).toBe("forbidden");
  });
  it("unreachable: closed port is `unreachable` (transient)", async () => {
    const w = await worker();
    const port = w.srv.port;
    await w.srv.close();
    const e = await w.as("mac").call("windows", "ping", {}, { timeoutMs: 2000 }).catch((x) => x);
    expect(e).toMatchObject({ code: "unreachable", transient: true, machine: "windows" });
    expect(port).toBeGreaterThan(0);
  });
  it("side-effect op: same opId runs once, replay returns the first result with meta.replayed", async () => {
    let n = 0;
    const w = await worker({ close: async () => ({ killed: [++n] }) });
    const c = w.as("mac");
    const a = await c.call<any>("windows", "close", { taskId: "T" }, { opId: "same" });
    const b = await c.call<any>("windows", "close", { taskId: "T" }, { opId: "same" });
    expect(n).toBe(1);
    expect(b.result).toEqual(a.result);
    expect(b.meta?.replayed).toBe(true);
    expect(a.meta?.replayed).toBeUndefined();
  });
  it("same opId with different args is a conflict", async () => {
    const w = await worker({ close: async () => ({ killed: [] }) });
    const c = w.as("mac");
    await c.call("windows", "close", { taskId: "A" }, { opId: "o" });
    expect(await c.call("windows", "close", { taskId: "B" }, { opId: "o" }).catch((x) => x)).toMatchObject({ code: "conflict" });
  });
  it("a failing handler is aborted and can be re-run with the same opId", async () => {
    let n = 0;
    const w = await worker({ close: async () => { if (++n === 1) throw new RemoteError("failed", "failed: boom"); return { killed: [n] }; } });
    const c = w.as("mac");
    expect(await c.call("windows", "close", { taskId: "A" }, { opId: "r" }).catch((x) => x)).toMatchObject({ code: "failed", message: "failed: boom" });
    expect((await c.call<any>("windows", "close", { taskId: "A" }, { opId: "r" })).result).toEqual({ killed: [2] });
  });
  it("concurrent calls with one opId execute once", async () => {
    let n = 0;
    const w = await worker({ close: async () => { n++; await new Promise((r) => setTimeout(r, 50)); return { killed: [] }; } });
    const c = w.as("mac");
    const rs = await Promise.all([1, 2, 3].map(() => c.call("windows", "close", { taskId: "A" }, { opId: "cc" })));
    expect(n).toBe(1);
    expect(rs.filter((r) => r.meta?.replayed)).toHaveLength(2);
  });
  it("op-status reports done/unknown and cancel writes a tombstone that blocks the later op", async () => {
    let n = 0;
    const w = await worker({ close: async () => { n++; return { killed: [] }; } });
    const c = w.as("mac");
    await c.call("windows", "close", { taskId: "A" }, { opId: "d1" });
    expect((await c.call<any>("windows", "op-status", { target: "d1" })).result.state).toBe("done");
    expect((await c.call<any>("windows", "op-status", { target: "nope" })).result.state).toBe("unknown");
    expect((await c.call<any>("windows", "op-status", { target: "nope", cancel: true })).result.state).toBe("cancelled");
    expect(await c.call("windows", "close", { taskId: "A" }, { opId: "nope" }).catch((x) => x)).toMatchObject({ code: "conflict" });
    expect(n).toBe(1);
  });
  it("a body above the limit is rejected as too_large before the body arrives; garbage is bad_request", async () => {
    const w = await worker();
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect((await raw(w.srv.port, head)).code).toBe("too_large");
    const junk = Buffer.concat([(() => { const h = Buffer.alloc(4); h.writeUInt32BE(3); return h; })(), Buffer.from("abc")]);
    expect((await raw(w.srv.port, junk)).code).toBe("bad_request");
  });
  it("slow-loris: a half frame is dropped after the read timeout", async () => {
    const w = await worker({}, { readTimeoutMs: 100 });
    const closed = await new Promise<boolean>((res) => {
      const s = net.connect(w.srv.port, "127.0.0.1", () => s.write(Buffer.from([0, 0, 0, 50, 1])));
      s.on("close", () => res(true));
      s.on("error", () => res(true));
    });
    expect(closed).toBe(true);
  });
  it("connections above the limit are closed at once", async () => {
    const w = await worker({}, { maxConnections: 2, readTimeoutMs: 5000 });
    const open = () => new Promise<net.Socket>((res) => { const s = net.connect(w.srv.port, "127.0.0.1", () => res(s)); });
    const [a, b] = [await open(), await open()];
    const third = await open();
    const closed = await new Promise<boolean>((res) => { third.on("close", () => res(true)); setTimeout(() => res(false), 2000); });
    for (const s of [a, b, third]) s.destroy();
    expect(closed).toBe(true);
  });
  it("a forged ok response without a valid signature is `auth` on the client", async () => {
    const fake = net.createServer((s) => s.on("data", (b) => {
      const [r] = new FrameDecoder().push(b) as AgentRequest[];
      s.end(encodeFrame({ v: 1, opId: r!.opId, ok: true, code: "ok", result: { machine: "evil" }, serverTs: Date.now(), build: "x", sig: "00" }));
    }));
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => fake.close(() => r())));
    const c = cfg();
    c.machines![1]!.agent.port = (fake.address() as net.AddressInfo).port;
    const e = await new AgentClient({ self: "mac", keys: { windows: K.mac }, config: () => c }).call("windows", "ping", {}).catch((x) => x);
    expect(e).toMatchObject({ code: "auth", message: "auth: yanıt imzası geçersiz" });
  });
});

describe("machines:B bind rule", () => {
  it("accepts loopback, RFC1918 and link-local; rejects wildcard and public addresses", async () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.5", "169.254.1.1", "localhost"]) await expect(assertPrivateBind(a), a).resolves.toBeTruthy();
    for (const a of ["0.0.0.0", "8.8.8.8", "172.32.0.1", "::", "no-such-host.invalid"]) await expect(assertPrivateBind(a), a).rejects.toThrow(/^agent: genel adrese bağlanılamaz: /);
  });
});
