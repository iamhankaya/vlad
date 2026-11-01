import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_MS, DEFAULT_AGENT_PORT, JOURNAL_RETENTION_DAYS, MAX_CONNECTIONS, MAX_FRAME_BYTES, PROTO_VERSION, RemoteError, TRANSIENT_CODES, nowMs,
  type AgentRequest, type AgentResponse, type RemoteTransport,
} from "../../src/machines/index.js";
import { FakeTransport } from "./harness.js";

describe("machines:S contract constants", () => {
  it("pins the protocol numbers other phases build on", () => {
    expect({ PROTO_VERSION, DEFAULT_AGENT_PORT, CLOCK_SKEW_MS, JOURNAL_RETENTION_DAYS, MAX_CONNECTIONS, MAX_FRAME_BYTES })
      .toEqual({ PROTO_VERSION: 1, DEFAULT_AGENT_PORT: 7437, CLOCK_SKEW_MS: 120_000, JOURNAL_RETENTION_DAYS: 14, MAX_CONNECTIONS: 16, MAX_FRAME_BYTES: 8 * 1024 * 1024 });
  });
  it("transient codes are exactly the retryable ones", () => {
    expect([...TRANSIENT_CODES].sort()).toEqual(["busy", "clock_skew", "timeout", "unreachable"]);
  });
});

describe("machines:S RemoteError", () => {
  it("carries code, machine and message; transient follows the code", () => {
    const e = new RemoteError("timeout", "yanıt gelmedi", "windows");
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ name: "RemoteError", code: "timeout", machine: "windows", message: "yanıt gelmedi", transient: true });
    expect(new RemoteError("forbidden", "x").transient).toBe(false);
  });
});

describe("machines:S wire shapes", () => {
  it("request and response envelopes have exactly the planned fields", () => {
    const req: AgentRequest = { v: 1, from: "mac", to: "windows", opId: "u", ts: 1, op: "ping", args: {}, sig: "s" };
    const res: AgentResponse = { v: 1, opId: "u", ok: true, code: "ok", serverTs: 1, build: "b", sig: "s" };
    expect(Object.keys(req).sort()).toEqual(["args", "from", "op", "opId", "sig", "to", "ts", "v"]);
    expect(Object.keys(res).sort()).toEqual(["build", "code", "ok", "opId", "serverTs", "sig", "v"]);
  });
});

describe("machines:S clock", () => {
  const prev = process.env.VLAD_NOW_FILE;
  afterEach(() => { if (prev === undefined) delete process.env.VLAD_NOW_FILE; else process.env.VLAD_NOW_FILE = prev; });
  it("nowMs reads VLAD_NOW_FILE on every call; falls back to Date.now", () => {
    const f = join(mkdtempSync(join(tmpdir(), "vlad-now-")), "now");
    process.env.VLAD_NOW_FILE = f;
    writeFileSync(f, "1000\n");
    expect(nowMs()).toBe(1000);
    writeFileSync(f, "2500");
    expect(nowMs()).toBe(2500);
    writeFileSync(f, "garbage");
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(5000);
    delete process.env.VLAD_NOW_FILE;
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(5000);
  });
});

describe("machines:S FakeTransport implements RemoteTransport", () => {
  it("records calls, passes opId/as through, and propagates RemoteError", async () => {
    const t: RemoteTransport & FakeTransport = new FakeTransport((c) => {
      if (c.op === "close") throw new RemoteError("unreachable", "bağlanamadı", c.to);
      return { head: "abc" };
    });
    const r = await t.call<{ head: string }>("windows", "kb-sync", { expectSha: "x" }, { opId: "op-1", as: "mac" });
    expect(r).toEqual({ opId: "op-1", result: { head: "abc" } });
    expect(t.calls).toEqual([{ to: "windows", op: "kb-sync", args: { expectSha: "x" }, opId: "op-1", as: "mac" }]);
    await expect(t.call("windows", "close", { taskId: "T20261101-01" })).rejects.toMatchObject({ code: "unreachable", machine: "windows" });
    expect((await t.call("windows", "ping", {})).opId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
