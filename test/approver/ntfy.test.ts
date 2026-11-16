import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NtfyChannel } from "../../src/approver/ntfy.js";
import type { PendingRecord, ChannelConfig, ResultRecord } from "../../src/approver/types.js";

vi.mock("../../src/approver/request.js", () => ({ renderNotification: () => ({ title: "T", message: "M" }) }));

const cfg: ChannelConfig = { v: 1, server: "https://ntfy.sh", requestTopic: "vlad-q-aaaa", createdAt: "x" };
const TOPIC = "vlad-r-aaaa";
const enc = new TextEncoder();
const streamOf = (chunks: (string | Uint8Array)[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(typeof x === "string" ? enc.encode(x) : x); c.close(); } });
const resp = (chunks: (string | Uint8Array)[], init: ResponseInit = {}) => new Response(streamOf(chunks), { status: 200, ...init });
const msg = (id: string, m: string, topic = TOPIC) => JSON.stringify({ id, event: "message", topic, message: m }) + "\n";

/** Her çağrıda sıradaki yanıtı verir; sıra bitince akışı abort eder. */
function setup(responses: (() => Response)[]) {
  const ac = new AbortController();
  const urls: string[] = [];
  let i = 0;
  const fetchFn = (async (u: string) => {
    urls.push(String(u));
    if (i >= responses.length) { ac.abort(); throw new Error("abort"); }
    return responses[i++]!();
  }) as unknown as typeof fetch;
  const delays: number[] = [];
  const sleep = async (ms: number) => { delays.push(ms); };
  const ch = new NtfyChannel(cfg, fetchFn, sleep);
  const bodies: string[] = [];
  const states: string[] = [];
  let ready = 0;
  const run = () => ch.watchResponse(TOPIC, 100, { onBody: (b) => bodies.push(b), onReady: () => ready++, onState: (s) => states.push(s) }, ac.signal);
  return { run, urls, delays, bodies, states, ready: () => ready };
}

describe("approver: ntfy kurucu", () => {
  it("https zorunlu, yalniz loopback icin http", () => {
    expect(() => new NtfyChannel({ ...cfg, server: "http://ntfy.sh" })).toThrow();
    expect(() => new NtfyChannel({ ...cfg, server: "ftp://x" })).toThrow();
    expect(() => new NtfyChannel({ ...cfg, server: "yok" })).toThrow();
    expect(() => new NtfyChannel({ ...cfg, server: "http://127.0.0.1:8080" })).not.toThrow();
    expect(() => new NtfyChannel({ ...cfg, server: "http://localhost:1" })).not.toThrow();
  });
});

describe("approver: ntfy yayin", () => {
  it("publishRequest JSON kok URL'ye, Reddet once", async () => {
    const calls: { u: string; init: RequestInit }[] = [];
    const f = (async (u: string, init: RequestInit) => { calls.push({ u, init }); return new Response("{}"); }) as unknown as typeof fetch;
    const p = { id: "idid", respTopic: TOPIC } as PendingRecord;
    await new NtfyChannel(cfg, f).publishRequest(p, { approve: "AAA", deny: "DDD" });
    expect(calls[0]!.u).toBe("https://ntfy.sh/");
    expect(calls[0]!.init.method).toBe("POST");
    const b = JSON.parse(String(calls[0]!.init.body));
    expect(b).toMatchObject({ topic: "vlad-q-aaaa", title: "T", message: "M", priority: 4 });
    expect(b.actions.map((a: { label: string }) => a.label)).toEqual(["Reddet", "Onayla"]);
    expect(b.actions[0]).toMatchObject({ action: "http", method: "POST", body: "d1.idid.DDD", url: `https://ntfy.sh/${TOPIC}`, clear: true });
    expect(b.actions[1].body).toBe("a1.idid.AAA");
  });
  it("HTTP hatasinda reddeder", async () => {
    const f = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(new NtfyChannel(cfg, f).publishRequest({ id: "i", respTopic: TOPIC } as PendingRecord, { approve: "a", deny: "d" })).rejects.toThrow();
  });
  it("publishResult ham stdout/stderr tasimaz", async () => {
    let body = "";
    const f = (async (_u: string, init: RequestInit) => { body = String(init.body); return new Response("{}"); }) as unknown as typeof fetch;
    const r: ResultRecord = { v: 1, id: "i", status: "done", exitCode: 0, stdout: "GIZLI-CIKTI", stderr: "GIZLI-HATA", finishedAt: "x" };
    await new NtfyChannel(cfg, f).publishResult(r);
    expect(body).not.toContain("GIZLI");
    expect(body).toContain("done");
  });
});

describe("approver: ntfy akis", () => {
  it("yalniz event=message ve topic eslesen islenir; ready; closed", async () => {
    const s = setup([() => resp([
      JSON.stringify({ event: "open", topic: TOPIC }) + "\n",
      JSON.stringify({ event: "keepalive", topic: TOPIC }) + "\n",
      JSON.stringify({ event: "poll_request", topic: TOPIC, message: "x" }) + "\n",
      JSON.stringify({ event: "message_delete", topic: TOPIC, message: "x" }) + "\n",
      msg("m0", "baska", "vlad-r-zzzz"),
      "\n", "bozuk{\n", "x".repeat(20000) + "\n",
      msg("m1", "a1.id.tag"),
    ])]);
    await s.run();
    expect(s.bodies).toEqual(["a1.id.tag"]);
    expect(s.ready()).toBe(1);
    expect(s.states[0]).toBe("connecting");
    expect(s.states).toContain("ready");
    expect(s.states.at(-1)).toBe("closed");
  });
  it("parcali UTF-8 ve bolunen satir (fixture)", async () => {
    const fx = JSON.parse(readFileSync("test/fixtures/ntfy/docs-derived-stream-split-chunk.json", "utf8"));
    const chunks = fx.chunksBase64.map((c: string) => new Uint8Array(Buffer.from(c, "base64")));
    const fxTopic = JSON.parse(Buffer.from(fx.chunksBase64[0], "base64").toString().split("\n")[0]).topic;
    expect(fxTopic).toBe("vlad-r-aaaaaaaaaaaaaaaaaaaaaaaaaa");
    const ac = new AbortController();
    let n = 0;
    const f = (async () => { if (n++) { ac.abort(); throw new Error("a"); } return resp(chunks); }) as unknown as typeof fetch;
    const bodies: string[] = [];
    await new NtfyChannel(cfg, f, async () => {}).watchResponse(fxTopic, 1, { onBody: (b) => bodies.push(b) }, ac.signal);
    expect(bodies).toEqual(fx.expectedMessages);
  });
  it("yeniden baglanma: ustel 1,2,4 ve since=<son id>", async () => {
    const s = setup([() => resp([msg("m7", "p")]), () => new Response("", { status: 500 }), () => new Response("", { status: 500 }), () => resp([])]);
    await s.run();
    expect(s.urls[0]).toContain("since=100");
    expect(s.urls[1]).toContain("since=m7");
    expect(s.delays.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(s.states.filter((x) => x === "retry").length).toBeGreaterThanOrEqual(3);
  });
  it("429 Retry-After uyulur", async () => {
    const s = setup([() => new Response("", { status: 429, headers: { "retry-after": "17" } })]);
    await s.run();
    expect(s.delays[0]).toBe(17000);
    expect(s.ready()).toBe(0);
  });
  it("gecikme 60 sn ustunu asmaz", async () => {
    const s = setup(Array.from({ length: 10 }, () => () => new Response("", { status: 500 })));
    await s.run();
    expect(Math.max(...s.delays)).toBe(60000);
  });
  it("abort: temiz cikis ve closed", async () => {
    const ac = new AbortController();
    ac.abort();
    const states: string[] = [];
    await new NtfyChannel(cfg, (async () => { throw new Error("cagrilmamali"); }) as unknown as typeof fetch).watchResponse(TOPIC, 1, { onBody: () => {}, onState: (x) => states.push(x) }, ac.signal);
    expect(states).toEqual(["closed"]);
  });
});
