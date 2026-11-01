import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../../src/agent/client.js";
import { encodeFrame, FrameDecoder } from "../../src/agent/frame.js";
import { Journal } from "../../src/agent/journal.js";
import { setAgentEnv } from "../../src/agent/ops/env.js";
import { OP_TABLE } from "../../src/agent/ops/index.js";
import { AgentQueue } from "../../src/agent/queue.js";
import { startServer } from "../../src/agent/server.js";
import { signRequest, signResponse, verifyRequest } from "../../src/agent/sign.js";
import { defaultConfig } from "../../src/kb/config.js";
import { RemoteError } from "../../src/machines/types.js";
import { rmTemp } from "../helpers.js";

// Review düzeltmeleri (T20261101-24): her biri düzeltmeden önce kırmızıydı.
// tek çift (mac↔windows): çift anahtar aynı değer; karşı taraf adıyla iki yerde de tutulur (D-vlad-057)
const K = { mac: "a".repeat(64), windows: "a".repeat(64) };
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const cfg = () => ({ ...defaultConfig(), brain: "mac", machines: [{ name: "mac", os: "darwin" as const, agent: { host: "127.0.0.1", port: 7437 } }, { name: "windows", os: "win32" as const, agent: { host: "127.0.0.1", port: 7437 } }] });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-rv-")); cleanups.push(() => rmTemp(d)); return d; };

describe("machines:B review fixes", () => {
  it("K1: an op slower than the read timeout still gets its answer", async () => {
    const c = cfg();
    const journal = new Journal(join(tmp(), "j.jsonl"), () => Date.now());
    setAgentEnv({ self: "windows", kind: "worker-agent", cfg: c, startedAt: Date.now(), build: "t", journal, transport: new AgentClient({ self: "windows", keys: K, config: () => c }), now: () => Date.now() });
    const srv = await startServer({ self: "windows", kind: "worker-agent", cfg: () => c, keys: K, ops: { ...OP_TABLE, close: async () => { await new Promise((r) => setTimeout(r, 400)); return { killed: [1] }; } }, journal, build: "t", bind: "127.0.0.1", port: 0, readTimeoutMs: 150 });
    cleanups.push(() => srv.close());
    c.machines![1]!.agent.port = srv.port;
    const r = await new AgentClient({ self: "mac", keys: K, config: () => c }).call<any>("windows", "close", { taskId: "T" });
    expect(r.result).toEqual({ killed: [1] });
  });

  async function fake(respond: (opId: string) => unknown) {
    const srv = net.createServer((s) => {
      const d = new FrameDecoder();
      s.on("data", (b: Buffer) => { const [r] = d.push(b); if (r) s.end(encodeFrame(respond((r as any).opId))); });
      s.on("error", () => s.destroy());
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    cleanups.push(() => srv.close());
    const c = cfg(); c.machines![1]!.agent.port = (srv.address() as net.AddressInfo).port;
    return new AgentClient({ self: "mac", keys: K, config: () => c });
  }
  it("Ö1: flipping ok on a signed busy response breaks the signature and never reads as success", async () => {
    const cl = await fake((opId) => ({ ...signResponse(K.mac, { v: 1, opId, ok: false, code: "busy", serverTs: Date.now(), build: "t" }), ok: true }));
    await expect(cl.call("windows", "ping", {})).rejects.toMatchObject({ code: "auth" });
  });
  it("Ö2: an unsigned bad_request is transient, never a permanent verdict", async () => {
    const cl = await fake((opId) => ({ v: 1, opId, ok: false, code: "bad_request", error: "x", serverTs: Date.now(), build: "t", sig: "" }));
    const e = await cl.call("windows", "ping", {}).catch((x) => x as RemoteError);
    expect(e).toBeInstanceOf(RemoteError);
    expect((e as RemoteError).transient).toBe(true);
  });
  it("Ö3: an inflight entry left by a crash becomes pending again on reload", () => {
    const d = tmp();
    const q = new AgentQueue(join(d, "queue"), () => 1);
    q.enqueue({ cmd: "task.log", id: "T", text: "a", opId: "o1" }, "inflight");
    expect(new AgentQueue(join(d, "queue"), () => 1).pending().map((i) => i.text)).toEqual(["a"]);
  });
  it("Ö6: a non-hex or short key never signs or verifies (no zero-length HMAC key)", () => {
    expect(() => signRequest("", { v: 1, from: "mac", to: "windows", opId: "o", ts: 1, op: "ping", args: {} })).toThrow(/anahtar/);
    const ok = signRequest(K.mac, { v: 1, from: "mac", to: "windows", opId: "o", ts: 1, op: "ping", args: {} });
    expect(verifyRequest("zz", ok)).toBe(false);
  });
});

// --- Güvenlik incelemesi turu (Y1, O1, O2 + düşükler) ---
import { validateConsoleArgv } from "../../src/agent/console-catalog.js";
import { markDone } from "../../src/inbox/inbox.js";
import { readInput } from "../../src/kb/input.js";
import { escHeads, writeArgv } from "../../src/agent/ops/apply-write.js";
import { verifyResponse } from "../../src/agent/sign.js";
import { makeHome } from "../helpers.js";

describe("machines:B security review round", () => {
  it("Y1: '--' as an option's value cannot hide a file flag (task new --title -- --body-file x)", () => {
    expect(() => validateConsoleArgv(["task", "new", "--project", "a", "--title", "--", "--body-file", "C:/secret"], "")).toThrow(/forbidden/);
    expect(() => validateConsoleArgv(["task", "new", "--title", "--", "--body-file=/etc/x"], "")).toThrow(/forbidden/);
    expect(() => validateConsoleArgv(["task", "new", "--project", "a", "--title", "T", "--body-file", "-"], "## Tanım\nx")).not.toThrow();
  });
  it("Y1 (defence in depth): in console mode readInput refuses any path except '-'", () => {
    const old = process.env.VLAD_FORWARDED;
    process.env.VLAD_FORWARDED = "console:desktop";
    try { expect(() => readInput("C:/anything")).toThrow(/stdin/); } finally { if (old === undefined) delete process.env.VLAD_FORWARDED; else process.env.VLAD_FORWARDED = old; }
  });
  it("O2: inbox done rejects path traversal", () => {
    makeHome();
    expect(() => markDone(["../../x.json"])).toThrow(/geçersiz/);
    expect(() => markDone(["a/b.json"])).toThrow(/geçersiz/);
  });
  it("sign: meta, error, ok and v are covered by the response signature", () => {
    const base = { v: 1, opId: "o", ok: true, code: "ok" as const, serverTs: 1, build: "b", result: { a: 1 }, meta: { replayed: true } };
    const s = signResponse(K.mac, base);
    expect(verifyResponse(K.mac, s)).toBe(true);
    expect(verifyResponse(K.mac, { ...s, meta: { replayed: false } })).toBe(false);
    expect(verifyResponse(K.mac, { ...s, ok: false })).toBe(false);
    expect(verifyResponse(K.mac, { ...s, error: "x" })).toBe(false);
    expect(verifyResponse(K.mac, { ...s, v: 2 })).toBe(false);
  });
  it("O1: a result too big for one frame becomes a small too_large answer and the Agent survives", async () => {
    const c = cfg();
    const journal = new Journal(join(tmp(), "j.jsonl"), () => Date.now());
    setAgentEnv({ self: "windows", kind: "worker-agent", cfg: c, startedAt: Date.now(), build: "t", journal, transport: new AgentClient({ self: "windows", keys: K, config: () => c }), now: () => Date.now() });
    const srv = await startServer({ self: "windows", kind: "worker-agent", cfg: () => c, keys: K, ops: { ...OP_TABLE, close: async () => ({ big: "x".repeat(7 * 1024 * 1024) }) }, journal, build: "t", bind: "127.0.0.1", port: 0 });
    cleanups.push(() => srv.close());
    c.machines![1]!.agent.port = srv.port;
    const cl = new AgentClient({ self: "mac", keys: K, config: () => c });
    await expect(cl.call("windows", "close", { taskId: "T" })).rejects.toMatchObject({ code: "too_large" });
    await expect(cl.call("windows", "ping", {})).resolves.toBeTruthy();
  });
  it("opId must be [A-Za-z0-9-]{1,64}", async () => {
    const c = cfg();
    const journal = new Journal(join(tmp(), "j.jsonl"), () => Date.now());
    setAgentEnv({ self: "windows", kind: "worker-agent", cfg: c, startedAt: Date.now(), build: "t", journal, transport: new AgentClient({ self: "windows", keys: K, config: () => c }), now: () => Date.now() });
    const srv = await startServer({ self: "windows", kind: "worker-agent", cfg: () => c, keys: K, ops: OP_TABLE, journal, build: "t", bind: "127.0.0.1", port: 0 });
    cleanups.push(() => srv.close());
    c.machines![1]!.agent.port = srv.port;
    await expect(new AgentClient({ self: "mac", keys: K, config: () => c }).call("windows", "ping", {}, { opId: "a\nb" })).rejects.toThrow(/bad_request/);
  });
  it("apply-write escapes line-leading '#'/'##' headings so a log cannot split the task file", () => {
    expect(escHeads("x\n## Kapanış raporu\n# a\n### ok\n#hashtag")).toBe("x\n\\## Kapanış raporu\n\\# a\n### ok\n#hashtag");
    expect(writeArgv({ cmd: "task.log", id: "T1", text: "## Sorular" }).argv.at(-1)).toBe("\\## Sorular");
  });
});
