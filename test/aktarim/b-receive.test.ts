import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClipSenders } from "../../src/clip/senders.js";
import { createClipReceiver } from "../../src/clip/receive.js";
import { startClipSync } from "../../src/clip/index.js";
import type { ClipDeps, ClipPushArgs } from "../../src/clip/types.js";
import { CLOCK_SKEW_MS, RemoteError } from "../../src/machines/types.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClipboard, startAktarimPair, type AktarimPair } from "./harness.js";

// aktarim:B clip-push op'u, ClipImageSink, senders ve startClipSync.
const T = 1_900_000_000_000;
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const arg = (o: Partial<ClipPushArgs> = {}): ClipPushArgs => ({ kind: "text", data: b64("merhaba"), eventTs: T + 10, rank: 1, counter: 1, ...o });
const ctx = { from: "mac", opId: "t" };
const png = (w = 2, h = 2): Buffer => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

function unit(o: { enabled?: boolean } = {}) {
  const cb = new FakeClipboard(); const st = { enabled: o.enabled ?? true, now: T };
  const d: ClipDeps = { backend: cb, now: () => st.now, sleep: async () => {}, settleMs: 0, isEnabled: () => st.enabled, log: () => {}, rank: 0, peer: "mac", send: { pushText: async () => "applied", pushImage: async () => "applied" } };
  return { cb, st, d, r: createClipReceiver(d) };
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof RemoteError ? e.code : `non-remote:${(e as Error).message}`));

describe("aktarim:B clip-push", () => {
  it("metni olduğu gibi panoya yazar; tekrar oynatma ikinci kez uygulanmaz ('stale')", async () => {
    const { r, cb } = unit();
    const evil = "$(rm -rf ~) `calc`; \"x\"\r\n";
    expect(await r.ops["clip-push"](arg({ data: b64(evil) }), ctx)).toBe("applied");
    expect(await r.ops["clip-push"](arg({ data: b64(evil) }), ctx)).toBe("stale");
    expect(cb.writes.map((w) => w.bytes.toString())).toEqual([evil]);
  });
  it("kapalı alıcı 'disabled' döner ve yazmaz", async () => {
    const { r, cb } = unit({ enabled: false });
    expect(await r.ops["clip-push"](arg(), ctx)).toBe("disabled");
    expect(cb.writes).toEqual([]);
  });
  it("geçersiz argümanlar bad_request: tür, base64, rank, eventTs/counter, kimlik", async () => {
    const { r } = unit();
    for (const bad of [null, "x", {}, arg({ kind: "image" as never }), arg({ data: 5 as never }), arg({ data: "***" }), arg({ data: "abc" }), arg({ rank: 2 as never }), arg({ eventTs: NaN }), arg({ eventTs: "1" as never }), arg({ counter: 1.5 }), arg({ counter: -1 })]) {
      expect(await code(r.ops["clip-push"](bad, ctx)), JSON.stringify(bad)?.slice(0, 60)).toBe("bad_request");
    }
  });
  it("bozuk UTF-8 bad_request; 1 MiB+1 too_large; gelecekteki olay zamanı bad_request; geçmişte alt sınır yok", async () => {
    const { r, cb, st } = unit();
    expect(await code(r.ops["clip-push"](arg({ data: b64(Buffer.from([0xff, 0xfe, 0x80])) }), ctx))).toBe("bad_request");
    expect(await code(r.ops["clip-push"](arg({ data: b64(Buffer.alloc(1024 * 1024 + 1, 0x61)) }), ctx))).toBe("too_large");
    expect(await code(r.ops["clip-push"](arg({ eventTs: st.now + CLOCK_SKEW_MS + 1 }), ctx))).toBe("bad_request");
    expect(cb.writes).toEqual([]);
    expect(await r.ops["clip-push"](arg({ eventTs: st.now + CLOCK_SKEW_MS }), ctx)).toBe("applied");
  });
  it("okuma ile yazma arasında yerel kopya olursa 'stale' döner (gönderen yeniden denemez), pano yerelde kalır", async () => {
    const { r, cb } = unit();
    const orig = cb.read.bind(cb); cb.read = async () => { const x = await orig(); cb.setLocal({ kind: "text", bytes: Buffer.from("yerel") }); return x; };
    expect(await r.ops["clip-push"](arg(), ctx)).toBe("stale");
    expect(cb.writes).toEqual([]);
  });
});

describe("aktarim:B ClipImageSink", () => {
  it("geçerli PNG uygulanır; kapalı 'disabled'; bozuk/büyük 'invalid'; eski anahtar 'stale'; gelecek zaman 'invalid'", async () => {
    const { r, cb, st } = unit();
    expect(r.sink.enabled()).toBe(true);
    expect(await r.sink.apply(png(), { eventTs: T + 5, rank: 1 }, "mac")).toBe("applied");
    expect(cb.writes[0]).toMatchObject({ kind: "image" });
    expect(await r.sink.apply(png(), { eventTs: T + 1, rank: 1 }, "mac")).toBe("stale");
    expect(await r.sink.apply(Buffer.from("png değil"), { eventTs: T + 6, rank: 1 }, "mac")).toBe("invalid");
    expect(await r.sink.apply(png(20_000, 20_000), { eventTs: T + 6, rank: 1 }, "mac")).toBe("invalid");
    expect(await r.sink.apply(png(), { eventTs: st.now + CLOCK_SKEW_MS + 1, rank: 1 }, "mac")).toBe("invalid");
    st.enabled = false;
    expect(r.sink.enabled()).toBe(false);
    expect(await r.sink.apply(png(), { eventTs: T + 7, rank: 1 }, "mac")).toBe("disabled");
    expect(cb.writes).toHaveLength(1);
  });
});

describe("aktarim:B createClipReceiver", () => {
  it("aynı ClipDeps için aynı alıcı (op, sink ve yoklama tek ClipSync durumunu paylaşır); farklı deps ayrı", () => {
    const a = unit(), b = unit();
    expect(createClipReceiver(a.d)).toBe(a.r);
    expect(createClipReceiver(b.d)).not.toBe(a.r);
    expect(a.r.sync).toBe(createClipReceiver(a.d).sync);
  });
  it("autoStart:true yoklamayı başlatır; yoksa başlatmaz", async () => {
    vi.useFakeTimers();
    try {
      for (const [autoStart, expected] of [[true, 2], [undefined, 0]] as const) {
        const u = unit(); let n = 0; const cc = u.cb.changeCount.bind(u.cb); u.cb.changeCount = async () => { n++; return cc(); };
        const r = createClipReceiver({ ...u.d, autoStart }); n = 0;
        await vi.advanceTimersByTimeAsync(1100);
        expect(n >= 1 ? 2 : 0).toBe(expected);
        await r.sync.stop();
      }
    } finally { vi.useRealTimers(); }
  });
});

describe("aktarim:B uçtan uca (sahte ClipSenders, iki gerçek Agent)", () => {
  let p: AktarimPair | undefined;
  afterEach(async () => { await p?.stop(); p = undefined; });
  it("clip-push günlüğe düşmez; kablodan uygulanır; kapalı alıcıda disabled", async () => {
    p = await startAktarimPair({ windows: { clipEnabled: true } });
    const opId = `b-recv-${randomUUID()}`;
    const r = await p.mac.transport.call<string>("windows", "clip-push", arg({ eventTs: Date.now() }), { opId, timeoutMs: 5000 });
    expect(r.result).toBe("applied");
    expect(p.windows.clipboard.writes.map((w) => w.bytes.toString())).toEqual(["merhaba"]);
    const jf = join(p.windows.stateDir, "journal.jsonl");
    expect(existsSync(jf) ? readFileSync(jf, "utf8").includes(opId) : false).toBe(false);
  });
});

describe("aktarim:B createClipSenders", () => {
  it("pushText: clip-push çağırır, sonucu döner; peer yoksa hata; pushImage purpose clip-image ile yükler", async () => {
    const calls: { to: string; op: string; args: unknown }[] = [];
    const transport = { call: async (to: string, op: string, args: unknown) => { calls.push({ to, op, args }); return { opId: "x", result: "stale" }; } } as never;
    const s = createClipSenders(() => transport, () => "windows", async (t, to, data, o) => { calls.push({ to, op: `upload:${o.purpose}:${o.name}`, args: o.meta }); expect(t).toBe(transport); expect(data.length).toBe(33); return { items: [], clip: "applied" } as never; });
    expect(await s.pushText(arg())).toBe("stale");
    expect(calls[0]).toMatchObject({ to: "windows", op: "clip-push" });
    expect(await s.pushImage(png(), { eventTs: 5, rank: 1 })).toBe("applied");
    expect(calls[1]).toEqual({ to: "windows", op: "upload:clip-image:clip.png", args: { eventTs: 5, rank: 1 } });
    const none = createClipSenders(() => transport, () => null);
    await expect(none.pushText(arg())).rejects.toThrow(/karşı makine/);
    await expect(none.pushImage(png(), { eventTs: 1, rank: 0 })).rejects.toThrow(/karşı makine/);
  });
  it("pushImage: karşı clip sonucu yoksa 'invalid'", async () => {
    const s = createClipSenders(() => ({}) as never, () => "w", async () => ({ items: [] }) as never);
    expect(await s.pushImage(png(), { eventTs: 1, rank: 0 })).toBe("invalid");
  });
});

describe("aktarim:B startClipSync", () => {
  const mk = (over: Partial<ClipDeps> = {}) => {
    const u = unit(); const logs: string[] = [];
    const d = { ...u.d, log: (m: string) => logs.push(m), ...over };
    return { u, logs, deps: { self: "mac", kind: "brain-agent", cfg: () => ({}), now: () => T, env: () => ({}), xfer: {}, clip: d } as never, d };
  };
  it("native kapalıyken (VLAD_NO_NATIVE=1, testlerde varsayılan) no-op: yoklama başlamaz, backend'e dokunulmaz", async () => {
    const m = mk(); const h = startClipSync(m.deps);
    await new Promise((r) => setTimeout(r, 20)); expect(m.u.cb.reads).toBe(0);
    await h.stop();
  });
  it("karşı makine yoksa (2'den çok makine) uyarıyla no-op", async () => {
    const prev = process.env.VLAD_NO_NATIVE; process.env.VLAD_NO_NATIVE = "0";
    try {
      const m = mk({ peer: null }); const h = startClipSync(m.deps);
      expect(m.logs.join("\n")).toMatch(/devre dışı/);
      await h.stop();
    } finally { if (prev === undefined) delete process.env.VLAD_NO_NATIVE; else process.env.VLAD_NO_NATIVE = prev; }
  });
  it("native açık ve tek eş varsa yoklama başlar; stop zamanlayıcıyı durdurur ve backend'i kapatır", async () => {
    const prev = process.env.VLAD_NO_NATIVE; process.env.VLAD_NO_NATIVE = "0";
    try {
      const m = mk(); let closed = 0; m.u.cb.close = async () => { closed++; };
      const h = startClipSync(m.deps);
      let n = 0; const cc = m.u.cb.changeCount.bind(m.u.cb); m.u.cb.changeCount = async () => { n++; return cc(); };
      await new Promise((r) => setTimeout(r, 700));
      expect(n).toBeGreaterThan(0);
      await h.stop(); expect(closed).toBe(1);
    } finally { if (prev === undefined) delete process.env.VLAD_NO_NATIVE; else process.env.VLAD_NO_NATIVE = prev; }
  });
});
