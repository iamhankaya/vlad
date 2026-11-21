import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../../src/agent/client.js";
import { AgentQueue } from "../../src/agent/queue.js";
import { BACKGROUND_OPS, maint } from "../../src/agent/maintenance.js";
import { handleRequest, type ServerOpts } from "../../src/agent/server.js";
import { signRequest } from "../../src/agent/sign.js";
import { Journal } from "../../src/agent/journal.js";
import { PROTO_VERSION, RemoteError } from "../../src/fleet/types.js";
import { rmTemp } from "../helpers.js";

// F-vlad-368: beyin erişilemezken queue-flush dakikalarca uçuşta kalıp bakım betiğini kilitliyordu.

const dirs: string[] = [];
afterEach(() => { maint.reset(); for (const d of dirs.splice(0)) rmTemp(d); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-ft-")); dirs.push(d); return d; };
const w = (id: string, text: string) => ({ cmd: "task.log" as const, id, text, opId: `op-${text}` });

describe("F-vlad-368: bağlanma zaman aşımı", () => {
  it("hiç bağlanmayan adres connectTimeoutMs içinde unreachable ile düşer (istek zaman aşımını beklemez)", async () => {
    const cfg = { machines: [{ name: "a", os: "darwin", agent: { host: "127.0.0.1", port: 7437 } }, { name: "b", os: "win32", agent: { host: "10.255.255.1", port: 7437 } }], brain: "a" } as never;
    const client = new AgentClient({ self: "a", keys: { b: "0".repeat(64) }, config: () => cfg, defaultTimeoutMs: 30_000, connectTimeoutMs: 60, connect: () => new net.Socket() });
    const t0 = Date.now();
    const e = await client.call("b", "ping", {}).catch((x) => x);
    expect(e).toBeInstanceOf(RemoteError);
    expect((e as RemoteError).code).toBe("unreachable");
    expect((e as RemoteError).message).toMatch(/bağlanma zaman aşımı/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("F-vlad-368: kuyruk boşaltma süre sınırı", () => {
  it("send hiç dönmese de flush deadlineMs sonunda döner, girdi pending kalır ve sonraki flush kilitlenmez", async () => {
    const q = new AgentQueue(join(tmp(), "queue"), () => 1);
    q.enqueue(w("T1", "a"));
    const r = await q.flush(() => new Promise(() => {}), { deadlineMs: 50 });
    expect(r).toEqual({ sent: 0, failed: 0, remaining: 1 });
    expect(q.pending()[0]!.reason).toMatch(/zaman aşımı/);
    const sent: string[] = [];
    expect(await q.flush(async (i) => { sent.push(i.text!); })).toEqual({ sent: 1, failed: 0, remaining: 0 });
  });
});

describe("F-vlad-368: uçuştaki queue-flush bakımı kilitlemez", () => {
  const KEY = "ab".repeat(32);
  const opts = (j: Journal, ran: { flush: Promise<void> }): ServerOpts => ({
    self: "w", kind: "worker-agent", cfg: () => ({ brain: "b", machines: [{ name: "b", os: "darwin", agent: { host: "127.0.0.1", port: 1 } }, { name: "w", os: "win32", agent: { host: "127.0.0.1", port: 2 } }] }) as never,
    keys: { w: KEY }, journal: j, build: "t", bind: "127.0.0.1", port: 0,
    ops: { "queue-flush": () => { return ran.flush as Promise<unknown>; }, ping: async () => ({}) } as never,
  });
  it("BACKGROUND_OPS queue-flush içerir; uçuştayken maint.others/inflight 0 kalır", async () => {
    expect(BACKGROUND_OPS.has("queue-flush")).toBe(true);
    const j = new Journal(join(tmp(), "j.jsonl"), () => Date.now());
    let release!: () => void;
    const ran = { flush: new Promise<void>((r) => { release = r; }) };
    const req = signRequest(KEY, { v: PROTO_VERSION, from: "w", to: "w", opId: "flush-1", ts: Date.now(), op: "queue-flush", args: {} });
    const p = handleRequest(opts(j, ran), req);
    await new Promise((r) => setTimeout(r, 20));
    expect(maint.others("another")).toBe(0);
    expect(maint.inflight()).toBe(0);
    release();
    expect((await p).code).toBe("ok");
  });
  it("bakım açıkken queue-flush yine busy döner (eski modüllerle çalışmaz)", async () => {
    const j = new Journal(join(tmp(), "j.jsonl"), () => Date.now());
    maint.enter("selfUpdate");
    const req = signRequest(KEY, { v: PROTO_VERSION, from: "w", to: "w", opId: "flush-2", ts: Date.now(), op: "queue-flush", args: {} });
    expect((await handleRequest(opts(j, { flush: Promise.resolve() }), req)).code).toBe("busy");
  });
});
