import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentQueue, QUEUE_MAX_ENTRIES } from "../../src/agent/queue.js";
import { RemoteError } from "../../src/machines/types.js";
import { rmTemp } from "../helpers.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmTemp(d); });
const mk = () => { const d = mkdtempSync(join(tmpdir(), "vlad-q-")); dirs.push(d); return { d, q: new AgentQueue(join(d, "queue"), () => 1) }; };
const w = (id: string, text: string, opId = `op-${text}`) => ({ cmd: "task.log" as const, id, text, opId });

describe("machines:B queue", () => {
  it("keeps FIFO order by seq and survives reload", () => {
    const { d, q } = mk();
    q.enqueue(w("T1", "a")); q.enqueue(w("T2", "b")); q.enqueue(w("T1", "c"));
    expect(new AgentQueue(join(d, "queue"), () => 1).pending().map((i) => i.text)).toEqual(["a", "b", "c"]);
    expect(q.list().map((e) => e.seq)).toEqual([1, 2, 3]);
  });
  it("flush sends in order and removes sent entries", async () => {
    const { q } = mk();
    q.enqueue(w("T1", "a")); q.enqueue(w("T1", "b"));
    const sent: string[] = [];
    expect(await q.flush(async (i) => { sent.push(i.text!); })).toEqual({ sent: 2, failed: 0, remaining: 0 });
    expect(sent).toEqual(["a", "b"]);
  });
  it.each(["unreachable", "timeout", "busy", "clock_skew", "auth", "proto_mismatch", "uncertain"] as const)("%s stops the queue and the entry stays pending", async (code) => {
    const { q } = mk();
    q.enqueue(w("T1", "a")); q.enqueue(w("T2", "b"));
    const r = await q.flush(async () => { throw new RemoteError(code, `${code}: x`); });
    expect(r).toEqual({ sent: 0, failed: 0, remaining: 2 });
    expect(q.pending()[0]!.reason).toContain(code);
  });
  it("a permanent error moves the entry and the same task's later entries to failed/, other tasks continue", async () => {
    const { d, q } = mk();
    q.enqueue(w("T1", "a")); q.enqueue(w("T2", "b")); q.enqueue(w("T1", "c")); q.enqueue(w("T3", "d"));
    const sent: string[] = [];
    const r = await q.flush(async (i) => { if (i.text === "a") throw new RemoteError("forbidden", "forbidden: x"); sent.push(i.text!); });
    expect(r).toEqual({ sent: 2, failed: 2, remaining: 0 });
    expect(sent).toEqual(["b", "d"]);
    const failed = readdirSync(join(d, "queue", "failed"));
    expect(failed).toHaveLength(2);
    expect(q.list().filter((e) => e.state === "failed").map((e) => e.seq)).toEqual([1, 3]);
  });
  it("drop removes a pending or failed entry by seq; seq numbers never repeat", async () => {
    const { q } = mk();
    q.enqueue(w("T1", "a"));
    await q.flush(async () => { throw new RemoteError("failed", "failed: x"); });
    expect(q.remove(1)).toBe(true);
    expect(q.enqueue(w("T1", "b")).seq).toBe(2);
    expect(q.remove(99)).toBe(false);
  });
  it("sweeps .tmp leftovers and moves corrupt JSON to failed/ on load", () => {
    const { d } = mk();
    writeFileSync(join(d, "queue", "00000009-x.json.tmp"), "{");
    writeFileSync(join(d, "queue", "00000008-bad.json"), "{not json");
    const q = new AgentQueue(join(d, "queue"), () => 1);
    expect(existsSync(join(d, "queue", "00000009-x.json.tmp"))).toBe(false);
    expect(q.pending()).toEqual([]);
    expect(readdirSync(join(d, "queue", "failed"))).toEqual(["00000008-bad.json"]);
  });
  it("refuses to grow past the entry limit with a transient `busy`", () => {
    const { q } = mk();
    for (let i = 0; i < QUEUE_MAX_ENTRIES; i++) q.enqueue(w("T1", String(i), `o${i}`));
    expect(() => q.enqueue(w("T1", "x"))).toThrowError(expect.objectContaining({ code: "busy", transient: true }));
  });
  it("an inflight entry blocks flush (order is kept) until it settles", async () => {
    const { q } = mk();
    const a = q.enqueue(w("T1", "a"), "inflight");
    q.enqueue(w("T1", "b"));
    expect((await q.flush(async () => { throw new Error("must not run"); })).remaining).toBe(2);
    q.setState(a.seq, "pending");
    expect((await q.flush(async () => {})).sent).toBe(2);
  });
});
