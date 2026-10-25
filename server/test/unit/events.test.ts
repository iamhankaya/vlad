import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { diffSnapshots, toSnapshot, vladSnapshot, type Snapshot } from "../../src/events/diff.ts";
import { frame, SseHub, type Sink } from "../../src/events/hub.ts";
import { EventLedger, EVENT_TYPES } from "../../src/events/ledger.ts";
import { EventWatcher, startKbWatch } from "../../src/events/watch.ts";
import { pairDevice, rig, signedCall, tmpState, type Rig, type TestDevice } from "../helpers/client.ts";
import { doc, validator } from "../helpers/openapi.ts";

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ tasks: {}, cards: {}, quota: { limited: false }, ...over });
const task = (state: string, updated: string, progress: { pct: number | null; at: string } | null = null) => ({ project: "vlad", state, updated, progress });

class Rec implements Sink {
  out: string[] = [];
  ended = false;
  backlog = 0;
  write(c: string) { this.out.push(c); return true; }
  end() { this.ended = true; }
  get writableLength() { return this.backlog; }
  get text() { return this.out.join(""); }
}

/** Lets pending I/O callbacks run without any timer: bounded setImmediate turns until `cond` holds. */
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 5000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error(`never became true: ${what}`);
}

const schema = (name: string) => validator({ $ref: `#/components/schemas/${name}` });
const parseFrames = (text: string) =>
  text.split("\n\n").filter((f) => f.startsWith("id: ")).map((f) => {
    const [id, event, data] = f.split("\n");
    return { id: Number(id!.slice(4)), event: event!.slice(7), data: JSON.parse(data!.slice(6)) };
  });

describe("server: diffSnapshots", () => {
  it("server: diffSnapshots same (task,state,updated) one event", () => {
    const prev = snap({ tasks: { "T20261025-01": task("running", "2026-10-25T10:00:00Z") } });
    const next = snap({ tasks: { "T20261025-01": task("awaiting_approval", "2026-10-25T11:00:00Z") } });
    const evs = diffSnapshots(prev, next);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "task.state", data: { task_id: "T20261025-01", state: "awaiting_approval" } });
    // the same look repeated, or seen again after a restart with a different `prev`, lands in the ledger once
    const ledger = new EventLedger(tmpState());
    for (const p of [prev, snap({ tasks: { "T20261025-01": task("blocked", "x") } }), prev]) for (const e of diffSnapshots(p, next)) ledger.append(e.type, e.data, e.key);
    expect(ledger.size).toBe(1);
    // a new `updated` is a new event; a new state at the same `updated` too
    const later = snap({ tasks: { "T20261025-01": task("awaiting_approval", "2026-10-25T12:00:00Z") } });
    expect(diffSnapshots(snap({ tasks: { "T20261025-01": task("blocked", "y") } }), later)[0]!.key).not.toBe(evs[0]!.key);
  });

  it("a cold start seeds without events; unchanged looks yield nothing", () => {
    const s = snap({ tasks: { "T20261025-01": task("running", "a") }, cards: { "C-20261025-01": { project: "vlad" } } });
    expect(diffSnapshots(null, s)).toEqual([]);
    expect(diffSnapshots(s, structuredClone(s))).toEqual([]);
  });

  it("emits the other event types: new task, progress, opened card, quota flip (both ways)", () => {
    const prev = snap({ tasks: { "T20261025-01": task("running", "a", { pct: 10, at: "t1" }) } });
    const next = snap({
      tasks: { "T20261025-01": task("running", "b", { pct: 60, at: "t2" }), "T20261025-02": task("queued", "c") },
      cards: { "C-20261025-01": { project: "vlad" } },
      quota: { limited: true },
    });
    const evs = diffSnapshots(prev, next);
    expect(evs.map((e) => e.type)).toEqual(["worker.progress", "task.state", "card.opened", "quota.changed"]);
    expect(evs[0]!.data).toEqual({ task_id: "T20261025-01", pct: 60 });
    expect(diffSnapshots(next, prev).map((e) => e.type)).toContain("quota.changed");
    expect(diffSnapshots(prev, snap({ tasks: { "T20261025-01": task("running", "a", { pct: 10, at: "t1" }) }, cards: { "C-20261025-01": { project: "vlad" } } })).map((e) => e.type)).toEqual(["card.opened"]);
  });

  it("event data carries ids and the new state only, never titles or report text", () => {
    const s = toSnapshot(
      [{ id: "T20261025-01", project: "vlad", title: "GİZLİ BAŞLIK", kind: "dev", state: "running", autonomy: "commit", created: "a", updated: "b", progress: { pct: 5, label: "GİZLİ ADIM", at: "c" } }],
      [{ id: "C-20261025-01", kind: "vlad_question", project: "vlad", task: null, state: "open", title: "GİZLİ SORU", options: [], answer: null, created: "a", updated: "b" }],
      { limited: false },
    );
    const evs = diffSnapshots(snap({ tasks: { "T20261025-01": task("queued", "a") } }), s);
    expect(JSON.stringify(evs)).not.toMatch(/GİZLİ/);
    expect(evs.every((e) => EVENT_TYPES.includes(e.type))).toBe(true);
  });
});

describe("server: event ledger", () => {
  it("seq grows by one, survives a restart, and a torn last line is ignored", () => {
    const dir = tmpState();
    const a = new EventLedger(dir);
    expect(a.lastSeq).toBe(0);
    a.append("quota.changed", { limited: true });
    a.append("quota.changed", { limited: false });
    appendFileSync(join(dir, "events.jsonl"), '{"seq":3,"type":"quota.ch'); // crash mid-append
    const b = new EventLedger(dir);
    expect(b.lastSeq).toBe(2);
    expect(b.append("quota.changed", { limited: true })!.seq).toBe(3);
    expect(b.after(0, 10).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("a partial last line is cut off at load: the next append neither glues onto it nor reuses its seq", () => {
    const dir = tmpState();
    const a = new EventLedger(dir);
    a.append("quota.changed", { limited: true });
    a.append("quota.changed", { limited: false });
    appendFileSync(join(dir, "events.jsonl"), '{"seq":3,"type":"quota.ch');
    const b = new EventLedger(dir);
    expect(b.append("card.opened", { card_id: "C-1" })!.seq).toBe(3);
    const c = new EventLedger(dir);
    expect(c.after(0, 10).map((e) => [e.seq, e.type])).toEqual([[1, "quota.changed"], [2, "quota.changed"], [3, "card.opened"]]);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
    expect(c.append("quota.changed", { limited: true })!.seq).toBe(4);
  });

  it("keys dedup across a restart", () => {
    const dir = tmpState();
    new EventLedger(dir).append("card.opened", { card_id: "C-1" }, "card.opened:C-1");
    const again = new EventLedger(dir);
    expect(again.append("card.opened", { card_id: "C-1" }, "card.opened:C-1")).toBeNull();
    expect(again.lastSeq).toBe(1);
  });

  it("memory and file stay bounded: oldest events are dropped, seq keeps rising", () => {
    const dir = tmpState();
    const l = new EventLedger(dir, 5);
    for (let i = 0; i < 100; i++) {
      l.append("worker.progress", { task_id: "T20261025-01", pct: i }, `k${i}`);
      expect(l.size).toBeLessThanOrEqual(5);
      expect(readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).length).toBeLessThanOrEqual(10);
    }
    expect(l.lastSeq).toBe(100);
    expect(l.firstSeq).toBe(96);
    const r = new EventLedger(dir, 5);
    expect(r.lastSeq).toBe(100);
    expect(r.after(0, 500).map((e) => e.seq)).toEqual([96, 97, 98, 99, 100]);
    expect(r.append("worker.progress", {}, "k0")!.seq).toBe(101); // an evicted key may be used again
  });

  it("server: seq gap detection", () => {
    const l = new EventLedger(tmpState(), 3);
    for (let i = 0; i < 10; i++) l.append("quota.changed", { limited: i % 2 === 0 });
    expect(l.hasGapAfter(0)).toBe(true); // 1..7 are gone
    expect(l.hasGapAfter(7)).toBe(false); // 8 is the oldest kept: nothing missed after 7
    expect(l.hasGapAfter(6)).toBe(true);
    expect(l.hasGapAfter(10)).toBe(false);
    // a client sees the gap in the data itself: the first event after its position is not position + 1
    expect(l.after(2, 10)[0]!.seq).toBe(8); // 3..7 missing
    // seqs are contiguous inside the retained window
    const seqs = l.after(0, 10).map((e) => e.seq);
    expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1)).toBe(true);
  });

  it("rejects oversized event data", () => {
    expect(() => new EventLedger(tmpState()).append("chat.delta", { text: "x".repeat(5000) })).toThrow(/too large/);
  });
});

describe("server: SSE hub", () => {
  const mk = (over: Partial<ConstructorParameters<typeof SseHub>[0]> = {}) => {
    const ledger = new EventLedger(tmpState());
    const active = new Set(["d-a", "d-b"]);
    const hub = new SseHub({ ledger, isActive: (id) => active.has(id), ...over });
    return { ledger, hub, active };
  };

  it("server: Last-Event-ID replay", () => {
    const { ledger, hub } = mk();
    for (let i = 0; i < 4; i++) ledger.append("quota.changed", { limited: i % 2 === 0 });
    const s = new Rec();
    expect(hub.open("d-a", s, 2).ok).toBe(true);
    ledger.append("task.state", { task_id: "T20261025-01", state: "done" }); // live, after the replay
    expect(parseFrames(s.text).map((f) => f.id)).toEqual([3, 4, 5]);
    expect(s.text).toContain("id: 3\nevent: quota.changed\ndata: {");
    const none = new Rec();
    hub.open("d-a", none, null);
    expect(parseFrames(none.text)).toEqual([]); // no Last-Event-ID: live only
    expect(frame({ seq: 9, type: "card.opened", data: { card_id: "C-1" } })).toBe('id: 9\nevent: card.opened\ndata: {"seq":9,"type":"card.opened","data":{"card_id":"C-1"}}\n\n');
  });

  it("a replay from before the retained window announces the gap", () => {
    const ledger = new EventLedger(tmpState(), 2);
    const hub = new SseHub({ ledger, isActive: () => true });
    for (let i = 0; i < 6; i++) ledger.append("quota.changed", { limited: true });
    const s = new Rec();
    hub.open("d-a", s, 1);
    expect(s.text).toContain(": gap first=5");
    expect(parseFrames(s.text).map((f) => f.id)).toEqual([5, 6]);
  });

  it("server: many SSE connections capped", () => {
    const { hub } = mk({ maxStreams: 4, maxPerDevice: 4 });
    const sinks = [new Rec(), new Rec(), new Rec(), new Rec()];
    for (const s of sinks) expect(hub.open("d-a", s, null).ok).toBe(true);
    expect(hub.count).toBe(4);
    const over = new Rec();
    expect(hub.open("d-b", over, null)).toEqual({ ok: false, reason: "capacity" });
    expect(hub.count).toBe(4);
    expect(sinks.every((s) => !s.ended)).toBe(true);
    sinks[0]!.end();
    hub.closeDevice("d-a");
    expect(hub.count).toBe(0);
    expect(hub.open("d-b", over, null).ok).toBe(true); // room again
  });

  it("per device the oldest stream is replaced; the global cap refuses a newcomer", () => {
    const { hub } = mk({ maxStreams: 3, maxPerDevice: 2 });
    const [a1, a2, a3, b1, b2] = [new Rec(), new Rec(), new Rec(), new Rec(), new Rec()];
    hub.open("d-a", a1!, null);
    hub.open("d-a", a2!, null);
    expect(hub.open("d-a", a3!, null).ok).toBe(true); // replaces a1
    expect(a1!.ended).toBe(true);
    expect(hub.countFor("d-a")).toBe(2);
    expect(hub.open("d-b", b1!, null).ok).toBe(true);
    expect(hub.open("d-b", b2!, null).ok).toBe(false); // 3 open, cap 3, d-b has nothing to replace
    expect(hub.count).toBe(3);
    expect(b2!.text).toBe(""); // a refused stream got nothing written
  });

  it("closes a stream whose backlog grows (slow reader) and one whose device is no longer active", () => {
    const { ledger, hub, active } = mk({ maxBacklog: 100 });
    const slow = new Rec();
    const gone = new Rec();
    hub.open("d-a", slow, null);
    hub.open("d-b", gone, null);
    slow.backlog = 101;
    ledger.append("quota.changed", { limited: true });
    expect(slow.ended).toBe(true);
    expect(gone.ended).toBe(false);
    active.delete("d-b"); // revoked without the hook having run
    ledger.append("quota.changed", { limited: false });
    expect(gone.ended).toBe(true);
    expect(hub.count).toBe(0);
    expect(hub.open("d-b", new Rec(), null).ok).toBe(false); // an inactive device never gets a stream
  });

  it("a revoked device gets neither a live event nor a keepalive, even before the revoke hook ran", () => {
    let tick: (() => void) | undefined;
    const { ledger, hub, active } = mk({ every: (_ms, fn) => { tick = fn; return () => {}; } });
    const s = new Rec();
    hub.open("d-a", s, null);
    active.delete("d-a");
    tick!();
    expect(s.text).not.toContain("keepalive");
    expect(s.ended).toBe(true);
    const t = new Rec();
    hub.open("d-b", t, null);
    active.delete("d-b");
    ledger.append("quota.changed", { limited: true });
    expect(t.text).not.toContain("quota.changed");
    expect(t.ended).toBe(true);
  });

  it("a client ahead of the ledger is told to reset; no keepalive timer for a stream that is already closed", () => {
    const { ledger, hub } = mk();
    ledger.append("quota.changed", { limited: true });
    const s = new Rec();
    hub.open("d-a", s, 40);
    expect(s.text).toContain(": reset last_seq=1");
    expect(parseFrames(s.text)).toEqual([]);
    let timers = 0;
    const full = mk({ every: () => { timers++; return () => {}; }, maxBacklog: 0 });
    const slow = new Rec();
    slow.backlog = 1; // over the backlog right at admission
    full.hub.open("d-a", slow, null);
    expect(slow.ended).toBe(true);
    expect(timers).toBe(0);
  });

  it("keepalive comes from the injected timer and stops with the stream", () => {
    let tick: (() => void) | undefined;
    let cancelled = 0;
    const { hub } = mk({ every: (ms, fn) => { expect(ms).toBe(20_000); tick = fn; return () => { cancelled++; }; } });
    const s = new Rec();
    const a = hub.open("d-a", s, null);
    tick!();
    expect(s.text).toContain(": keepalive\n\n");
    if (a.ok) a.stream.close();
    expect(cancelled).toBe(1);
    expect(hub.count).toBe(0);
  });
});

describe("server: event watcher", () => {
  it("seeds on the first look, then appends differences; failures keep the previous look", async () => {
    const ledger = new EventLedger(tmpState());
    let cur: Snapshot | Error = snap({ tasks: { "T20261025-01": task("running", "a") } });
    const errors: unknown[] = [];
    const w = new EventWatcher({ ledger, snapshot: async () => { if (cur instanceof Error) throw cur; return cur; }, onError: (e) => errors.push(e) });
    expect(await w.poll()).toBe(0);
    expect(ledger.lastSeq).toBe(0);
    cur = new Error("vlad down");
    expect(await w.poll()).toBe(0);
    expect(errors).toHaveLength(1);
    cur = snap({ tasks: { "T20261025-01": task("done", "b") } });
    expect(await w.poll()).toBe(1);
    expect(await w.poll()).toBe(0);
    expect(ledger.after(0, 10).map((e) => e.type)).toEqual(["task.state"]);
  });

  it("an append that throws does not reject or crash; the next poll recovers without duplicates", async () => {
    const ledger = new EventLedger(tmpState());
    let cur = snap({ tasks: { "T20261025-01": task("running", "a") } });
    const errors: unknown[] = [];
    const w = new EventWatcher({ ledger, snapshot: async () => cur, onError: (e) => errors.push(e) });
    await w.poll(); // seed
    cur = snap({ tasks: { "T20261025-01": task("done", "b") }, quota: { limited: true } });
    const real = ledger.append.bind(ledger);
    let failTask = true;
    const spy = vi.spyOn(ledger, "append").mockImplementation((type, data, key) => {
      if (type === "task.state" && failTask) throw new Error("ENOSPC");
      return real(type, data, key);
    });
    await expect(w.poll()).resolves.toBe(0); // task.state fails first (ids sort before quota)
    expect(errors).toHaveLength(1);
    failTask = false;
    await expect(w.poll()).resolves.toBe(2);
    await w.poll();
    spy.mockRestore();
    expect(ledger.after(0, 10).map((e) => e.type).sort()).toEqual(["quota.changed", "task.state"]);
  });

  it("polls never overlap: a poll during a look causes exactly one more look", async () => {
    const ledger = new EventLedger(tmpState());
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const w = new EventWatcher({
      ledger,
      snapshot: async () => {
        calls++;
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        return snap();
      },
    });
    await Promise.all([w.poll(), w.poll(), w.poll()]);
    expect(maxInFlight).toBe(1);
    expect(calls).toBe(2);
  });

  it("file events are debounced into one poll; the fallback tick polls too; stop releases everything", async () => {
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let id = 0;
    const cbs: (() => void)[] = [];
    let closed = 0;
    let looks = 0;
    const watcher = new EventWatcher({ ledger: new EventLedger(tmpState()), snapshot: async () => { looks++; return snap(); } });
    const stop = startKbWatch({
      watcher, dirs: ["a", "b"], debounceMs: 500, fallbackMs: 30_000,
      watch: (_d, cb) => { cbs.push(cb); return { close: () => { closed++; } }; },
      setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
      clearTimer: (t) => { timers.delete(t as number); },
    });
    await until(() => looks === 1, "seed look");
    for (let i = 0; i < 10; i++) cbs[i % 2]!();
    const debounced = [...timers.values()].filter((t) => t.ms === 500);
    expect(debounced).toHaveLength(1); // a burst of ten file events: one pending poll
    const fire = (t: { fn: () => void; ms: number }) => { for (const [k, v] of timers) if (v === t) timers.delete(k); t.fn(); }; // one-shot timers
    fire(debounced[0]!);
    await until(() => looks >= 2, `debounced look (looks=${looks})`);
    fire([...timers.values()].find((t) => t.ms === 30_000)!); // fallback tick
    expect([...timers.values()].filter((t) => t.ms === 500)).toHaveLength(1);
    stop();
    expect(closed).toBe(2);
    expect(timers.size).toBe(0);
  });
});

describe("server: /events and /stream over HTTP", () => {
  let r: Rig;
  let d: TestDevice;
  const events = () => r.app.vladEvents;
  const call = (target: string, headers: Record<string, string> = {}, dev = d) => {
    const h = dev.headers(r.clock, "GET", target);
    return r.app.inject({ method: "GET", url: target, headers: { ...h, ...headers } });
  };
  const seed = (n: number) => { for (let i = 0; i < n; i++) events().ledger.append("quota.changed", { limited: i % 2 === 0 }); };
  const revoke = (caller: TestDevice, target: string) => {
    const body = caller.revokeBody(target, r.clock.t);
    return signedCall(r, caller, "POST", `/v1/devices/${target}/revoke`, body);
  };

  const fresh = async () => {
    r = rig({ events: { maxStreams: 3, maxPerDevice: 2, every: () => () => {} } });
    d = await pairDevice(r, "Phone A");
  };

  it("pages the ledger and validates against openapi", async () => {
    await fresh();
    seed(5);
    const res = await call("/v1/events?after=1&limit=2");
    expect(res.statusCode).toBe(200);
    expect(schema("EventList")(res.json())).toEqual([]);
    expect(res.json().events.map((e: { seq: number }) => e.seq)).toEqual([2, 3]);
    expect(res.json().last_seq).toBe(5);
    const dflt = (await call("/v1/events")).json();
    expect(dflt.events).toHaveLength(5);
    expect(schema("EventList")(dflt)).toEqual([]);
    expect((await call("/v1/events?after=5")).json()).toEqual({ events: [], last_seq: 5 });
    expect((await call("/v1/events?after=99999")).json()).toEqual({ events: [], last_seq: 5 }); // ahead of the ledger: empty, last_seq tells
  });

  it("server: /events after negative or huge and limit bounds", async () => {
    await fresh();
    seed(2);
    const bad = ["after=-1", "after=9007199254740992", "after=99999999999999999999", "after=1.5", "after=", "after=abc", "after=0x1", "after=%2B1", "limit=0", "limit=501", "limit=-1", "limit=", "limit=1e2", "limit=0100x", "limit=9999999", "foo=1", "after=1&x"];
    for (const q of bad) {
      const res = await call(`/v1/events?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code).toBe("bad_request");
    }
    for (const q of ["after=0", "after=9007199254740991", "limit=1", "limit=500", "after=0&limit=500", ""]) expect((await call(`/v1/events${q ? "?" + q : ""}`)).statusCode, q).toBe(200);
    expect((await call("/v1/events?limit=500")).json().events).toHaveLength(2);
  });

  it("both event routes need a signature, like every other route", async () => {
    await fresh();
    for (const url of ["/v1/events", "/v1/events?after=0", "/v1/stream"]) expect((await r.app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    expect((await r.app.inject({ method: "GET", url: "/v1/stream", headers: { "last-event-id": "1" } })).statusCode).toBe(401);
    expect(events().hub.count).toBe(0);
  });

  it("stream: replays after Last-Event-ID then follows live events; ends when the device is revoked", async () => {
    await fresh();
    const b = await pairDevice(r, "Phone B");
    seed(3);
    const pending = call("/v1/stream", { "last-event-id": "1" }, b);
    await until(() => events().hub.count === 1, "stream open");
    events().ledger.append("task.state", { task_id: "T20261025-01", state: "done" });
    expect((await revoke(d, b.id)).statusCode).toBe(200);
    const res = await pending; // the revoke ended it
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-store");
    const frames = parseFrames(res.payload);
    expect(frames.map((f) => f.id)).toEqual([2, 3, 4]);
    for (const f of frames) {
      expect(schema("Event")(f.data)).toEqual([]);
      expect(f.event).toBe(f.data.type);
    }
    expect(events().hub.count).toBe(0);
  });

  it("server: revoke closes open SSE and invalidates pending challenges", async () => {
    const seen: string[] = [];
    r = rig({ events: { every: () => () => {} }, onRevoke: (id) => seen.push(id) });
    const a = await pairDevice(r, "Phone A");
    const b = await pairDevice(r, "Phone B");
    const c = await pairDevice(r, "Phone C");
    const ofB = [call2(b), call2(b)];
    const ofC = call2(c);
    function call2(dev: TestDevice) {
      const h = dev.headers(r.clock, "GET", "/v1/stream");
      return r.app.inject({ method: "GET", url: "/v1/stream", headers: h });
    }
    await until(() => r.app.vladEvents.hub.count === 3, "three streams");
    expect((await signedCall(r, a, "POST", `/v1/devices/${b.id}/revoke`, a.revokeBody(b.id, r.clock.t))).statusCode).toBe(200);
    for (const p of ofB) expect((await p).statusCode).toBe(200); // both of B's streams ended
    expect(r.app.vladEvents.hub.count).toBe(1);
    expect(r.app.vladEvents.hub.countFor(c.id)).toBe(1); // C's stream is untouched
    expect(seen).toEqual([b.id]); // extra revoke listener ran (S9a hangs the challenge store on it)
    // B cannot come back
    r.clock.t += 1;
    const again = await signedCall(r, b, "GET", "/v1/stream");
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe("device_revoked");
    r.app.vladEvents.hub.closeAll();
    await ofC;
  });

  it("revoking twice runs the listeners once; revoking a device with no stream is fine", async () => {
    const seen: string[] = [];
    r = rig({ onRevoke: (id) => seen.push(id) });
    const a = await pairDevice(r, "Phone A");
    const b = await pairDevice(r, "Phone B");
    expect((await signedCall(r, a, "POST", `/v1/devices/${b.id}/revoke`, a.revokeBody(b.id, r.clock.t))).statusCode).toBe(200);
    r.clock.t += 1;
    expect((await signedCall(r, a, "POST", `/v1/devices/${b.id}/revoke`, a.revokeBody(b.id, r.clock.t))).statusCode).toBe(200);
    expect(seen).toEqual([b.id]);
  });

  it("stream bad input: malformed Last-Event-ID and any query are 400, a full hub is 429", async () => {
    await fresh();
    for (const v of ["abc", "-1", "1.5", "12345678901234567", "9007199254740993", " 1", ""]) {
      const res = await call("/v1/stream", { "last-event-id": v });
      expect(res.statusCode, JSON.stringify(v)).toBe(400);
    }
    expect((await call("/v1/stream?after=1")).statusCode).toBe(400);
    expect(events().hub.count).toBe(0);
    const b = await pairDevice(r, "Phone B");
    const e = await pairDevice(r, "Phone E");
    const open = [call("/v1/stream"), call("/v1/stream"), call("/v1/stream", {}, b)];
    await until(() => events().hub.count === 3, "hub full");
    const refused = await call("/v1/stream", {}, e);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("rate_limited");
    expect(events().hub.count).toBe(3);
    events().hub.closeAll();
    await Promise.all(open);
  });

  it("closing the app ends open streams", async () => {
    await fresh();
    const p = call("/v1/stream");
    await until(() => events().hub.count === 1, "stream open");
    await r.app.close();
    expect((await p).statusCode).toBe(200);
  });
});

describe("server: Home.seq follows the ledger (fake vlad CLI)", () => {
  let tmp: string;
  const saved = { ...process.env };
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "vlad-ev-"));
    writeFileSync(join(tmp, "tasks.json"), JSON.stringify({ tasks: [], warnings: [] }));
    writeFileSync(join(tmp, "cli.js"), `
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2).filter((x) => x !== "--json");
const out = (o) => process.stdout.write(JSON.stringify(o));
if (a[0] === "task" && a[1] === "list") out(JSON.parse(fs.readFileSync(path.join(process.env.VLAD_HOME, "tasks.json"), "utf8")));
else if (a[0] === "card") out({ cards: [], warnings: [] });
else if (a[0] === "quota") out({ limited: false, until: null, warnings: [] });
else if (a[0] === "active") out({ active: null, mine: false, warnings: [] });
else { process.stderr.write("unknown"); process.exit(1); }
`);
    process.env.VLAD_HOME = tmp;
    process.env.VLAD_CLI = join(tmp, "cli.js");
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  const home = (r: Rig, d: TestDevice) => signedCall(r, d, "GET", "/v1/home");

  it("/home carries the ledger position, schema-valid, and it moves with new events", async () => {
    const r = rig();
    const d = await pairDevice(r);
    let res = await home(r, d);
    expect(res.statusCode).toBe(200);
    expect(res.json().seq).toBe(0);
    expect(schema("Home")(res.json())).toEqual([]);
    for (let i = 0; i < 3; i++) r.app.vladEvents.ledger.append("quota.changed", { limited: true });
    res = await home(r, d);
    expect(res.json().seq).toBe(3);
    expect(schema("Home")(res.json())).toEqual([]);
    // restart: the position is the persisted one
    const r2 = r.restart();
    const d2 = d; // same state dir, same device
    res = await home(r2, d2);
    expect(res.json().seq).toBe(3);
  });

  it("a new event drops the read cache, so a client reacting to it reads fresh data", async () => {
    const r = rig();
    const d = await pairDevice(r);
    expect((await home(r, d)).json().workers).toHaveLength(0);
    const t = { id: "T20261025-01", project: "vlad", title: "x", kind: "dev", state: "running", autonomy: "commit", created: "2026-10-25T10:00:00Z", updated: "2026-10-25T10:00:00Z" };
    writeFileSync(join(tmp, "tasks.json"), JSON.stringify({ tasks: [t], warnings: [] }));
    r.app.vladEvents.ledger.append("task.state", { task_id: t.id, state: "running" });
    const res = await home(r, d);
    expect(res.json().workers.map((w: { task_id: string }) => w.task_id)).toEqual([t.id]);
    expect(res.json().seq).toBe(1);
    writeFileSync(join(tmp, "tasks.json"), JSON.stringify({ tasks: [], warnings: [] }));
  });

  it("vladSnapshot reads tasks, open cards and quota through the CLI", async () => {
    const s = await vladSnapshot();
    expect(s).toEqual({ tasks: {}, cards: {}, quota: { limited: false } });
  });
});

describe("contract", () => {
  it("openapi event types equal the ledger's", () => {
    expect([...doc.components.schemas.EventType.enum].sort()).toEqual([...EVENT_TYPES].sort());
  });
});
