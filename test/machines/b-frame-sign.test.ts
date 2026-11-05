import { describe, expect, it } from "vitest";
import { FrameDecoder, encodeFrame } from "../../src/agent/frame.js";
import { canonicalJson, signRequest, signResponse, verifyRequest, verifyResponse } from "../../src/agent/sign.js";
import { MAX_FRAME_BYTES, RemoteError, type AgentRequest } from "../../src/fleet/types.js";

const KEY = "ab".repeat(32);
const req = (o: Partial<AgentRequest> = {}): AgentRequest => signRequest(KEY, { v: 1, from: "windows", to: "mac", opId: "op-1", ts: 1000, op: "ping", args: { b: 1, a: [2, { y: 1, x: 2 }] }, ...o });

describe("machines:B frame", () => {
  it("round-trips UTF-8 JSON (Turkish, CRLF, quotes) across arbitrary chunk splits", () => {
    const msg = { t: "çğıöşü\r\n\"$`\\", n: [1, 2] };
    const buf = encodeFrame(msg);
    const d = new FrameDecoder();
    const got: unknown[] = [];
    for (let i = 0; i < buf.length; i++) got.push(...d.push(buf.subarray(i, i + 1)));
    expect(got).toEqual([msg]);
  });
  it("incomplete frame yields nothing and reports pending bytes", () => {
    const d = new FrameDecoder();
    expect(d.push(encodeFrame({ a: 1 }).subarray(0, 6))).toEqual([]);
    expect(d.pending).toBe(true);
  });
  it("rejects a declared length above MAX_FRAME_BYTES as too_large before buffering", () => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect(() => new FrameDecoder().push(head)).toThrowError(expect.objectContaining({ code: "too_large" }));
  });
  it("rejects garbage payload as bad_request", () => {
    const body = Buffer.from("not json");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    expect(() => new FrameDecoder().push(Buffer.concat([head, body]))).toThrowError(expect.objectContaining({ code: "bad_request" }));
  });
  it("refuses to encode a frame above the limit", () => {
    expect(() => encodeFrame({ s: "x".repeat(MAX_FRAME_BYTES) })).toThrowError(expect.objectContaining({ code: "too_large" }));
  });
});

describe("machines:B sign", () => {
  it("canonicalJson sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
  it("accepts a valid request", () => {
    expect(verifyRequest(KEY, req())).toBe(true);
  });
  it("rejects changed args, wrong to, wrong from, wrong ts, wrong op, wrong opId, wrong key", () => {
    const r = req();
    expect(verifyRequest(KEY, { ...r, args: { a: 1 } })).toBe(false);
    expect(verifyRequest(KEY, { ...r, to: "windows" })).toBe(false); // reflected
    expect(verifyRequest(KEY, { ...r, from: "mac" })).toBe(false);
    expect(verifyRequest(KEY, { ...r, ts: 1001 })).toBe(false);
    expect(verifyRequest(KEY, { ...r, op: "exec" })).toBe(false);
    expect(verifyRequest(KEY, { ...r, opId: "op-2" })).toBe(false);
    expect(verifyRequest("cd".repeat(32), r)).toBe(false);
  });
  it("a malformed signature never throws", () => {
    expect(verifyRequest(KEY, { ...req(), sig: "zz" })).toBe(false);
    expect(verifyRequest(KEY, { ...req(), sig: undefined as unknown as string })).toBe(false);
  });
  it("response signature covers opId, code and result", () => {
    const r = signResponse(KEY, { v: 1, opId: "op-1", ok: true, code: "ok", result: { x: 1 }, serverTs: 5, build: "b" });
    expect(verifyResponse(KEY, r)).toBe(true);
    expect(verifyResponse(KEY, { ...r, result: { x: 2 } })).toBe(false);
    expect(verifyResponse(KEY, { ...r, code: "failed" })).toBe(false);
    expect(verifyResponse(KEY, { ...r, opId: "op-9" })).toBe(false);
    expect(verifyResponse(KEY, { ...r, result: undefined })).toBe(false);
  });
  it("missing result signs as null", () => {
    const r = signResponse(KEY, { v: 1, opId: "o", ok: true, code: "ok", serverTs: 5, build: "b" });
    expect(verifyResponse(KEY, r)).toBe(true);
    expect(RemoteError).toBeDefined();
  });
});
