import { describe, expect, it } from "vitest";
import { fetchCapacitySeries, CapacityFetchError } from "../../src/monitor/capacity-fetch.js";
import type { CapacityTrigger } from "../../src/monitor/capacity-config.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 23, 9, 0, 0);
const TOKEN = "SECRET-CAP-TOKEN";
const trigs: CapacityTrigger[] = [
  { id: "ws", title: "ws", metric: "app.ws_connections", measure: "peak", op: ">=", threshold: 300, unit: "u", source_item: 1 },
  { id: "cpu", title: "cpu", metric: "docker.container.cpu_pct", labels: { name: "app-1" }, measure: "daily_avg_peak", op: ">", threshold: 60, unit: "%", source_item: 1 },
];
const srv = { id: "medialog", agent_url: "http://127.0.0.1:1", project: "p" };
const item = (seq: number, ts: number, metric: string, labels: Record<string, string>, o: Partial<{ n: number; min: number; max: number; avg: number; last: number }> = {}) =>
  ({ seq, ts, metric, labels, n: 1, min: 5, max: 5, avg: 5, last: 5, ...o });
const page = (items: unknown[], o: Record<string, unknown> = {}) => ({
  server: "medialog", epoch: "e1", resolution: "1m", schema: 1, items, next_cursor: "c-next", has_more: false, gap: null, oldest_ts: NOW - 40 * DAY, ...o,
});
type Resp = { status: number; body: unknown };
function mkFetch(handler: (u: URL, i: number) => Resp) {
  const calls: { url: URL; auth: string | undefined; redirect: unknown }[] = [];
  const f = (async (u: string, init: RequestInit) => {
    const url = new URL(u);
    calls.push({ url, auth: (init.headers as Record<string, string>).authorization, redirect: init.redirect });
    const r = handler(url, calls.length - 1);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const run = (f: typeof fetch, over: Partial<Parameters<typeof fetchCapacitySeries>[0]> = {}) =>
  fetchCapacitySeries({ srv, token: TOKEN, triggers: trigs, now: NOW, fetch: f, ...over });

describe("fetchCapacitySeries", () => {
  it("1 dk özetleri tetikleyiciye göre günlük UTC kovalara indirger; uymayan metrik/etiket atılır", async () => {
    const d0 = NOW - 2 * DAY; // iki ayrı UTC günü
    const { f, calls } = mkFetch(() => ({ status: 200, body: page([
      item(1, d0, "app.ws_connections", {}, { n: 2, max: 120, avg: 100 }),
      item(2, d0 + 1000, "app.ws_connections", {}, { n: 3, min: 3, max: 150, avg: 110 }),
      item(3, d0 + DAY, "app.ws_connections", {}, { n: 1, max: 90, avg: 90 }),
      item(4, d0, "docker.container.cpu_pct", { name: "app-1" }, { n: 4, max: 70, avg: 50 }),
      item(5, d0, "docker.container.cpu_pct", { name: "baska" }, { max: 99 }),
      item(6, d0, "yabanci.metrik", {}, { max: 999 }),
    ]) }));
    const r = await run(f);
    const ws = Object.values(r.series.ws!);
    expect(ws).toHaveLength(1);
    const day0 = Math.floor(d0 / DAY);
    expect(ws[0]).toEqual([
      { day: day0, n: 5, max: 150, sum: 2 * 100 + 3 * 110, min: 3 }, // günlük min = dakikalık min'lerin en küçüğü (`<` yönlü tetikleyiciler için)
      { day: day0 + 1, n: 1, max: 90, sum: 90, min: 5 },
    ]);
    expect(Object.values(r.series.cpu!)).toEqual([[{ day: day0, n: 4, max: 70, sum: 200, min: 5 }]]);
    expect(r.items).toBe(6);
    expect(r.oldestTs).toBe(NOW - 40 * DAY);
    expect(calls[0]!.url.pathname).toBe("/spc/v1/since");
    expect(calls[0]!.url.searchParams.get("resolution")).toBe("1m");
    expect(calls[0]!.url.searchParams.get("limit")).toBe("5000");
    expect(calls[0]!.url.searchParams.get("from")).toBe(String(NOW - 30 * DAY));
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.redirect).toBe("error");
  });
  it("sayfalama: ikinci istek yalnız cursor (from ile birlikte verilmez)", async () => {
    const { f, calls } = mkFetch((_u, i) => ({ status: 200, body: i === 0 ? page([item(1, NOW - DAY, "app.ws_connections", {})], { has_more: true, next_cursor: "C1" }) : page([item(2, NOW - DAY, "app.ws_connections", {})]) }));
    const r = await run(f);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("C1");
    expect(calls[1]!.url.searchParams.has("from")).toBe(false);
    expect(r.items).toBe(2);
  });
  it("410 → baştan bir kez; ikinci 410 → unreachable", async () => {
    let n = 0;
    const { f, calls } = mkFetch(() => (n++ === 0 ? { status: 410, body: {} } : { status: 200, body: page([item(1, NOW - DAY, "app.ws_connections", {})]) }));
    await run(f);
    expect(calls[1]!.url.searchParams.get("from")).toBe(String(NOW - 30 * DAY));
    const { f: f2 } = mkFetch(() => ({ status: 410, body: {} }));
    await expect(run(f2)).rejects.toMatchObject({ code: "unreachable" });
  });
  it("sayfa tavanı aşılırsa page_limit; kısmi veri dönmez", async () => {
    const { f } = mkFetch(() => ({ status: 200, body: page([item(1, NOW - DAY, "app.ws_connections", {})], { has_more: true }) }));
    await expect(run(f, { maxPages: 3 })).rejects.toMatchObject({ code: "page_limit" });
  });
  it("hata sınıfları: 401/403 unauthorized, 500 unreachable, ağ hatası unreachable, şema uyumsuz", async () => {
    for (const [status, code] of [[401, "unauthorized"], [403, "unauthorized"], [500, "unreachable"]] as const) {
      await expect(run(mkFetch(() => ({ status, body: {} })).f)).rejects.toMatchObject({ code });
    }
    const boom = (async () => { throw new TypeError("fetch failed " + TOKEN); }) as unknown as typeof fetch;
    const e = await run(boom).catch((x) => x as CapacityFetchError);
    expect(e).toMatchObject({ code: "unreachable" });
    expect(String((e as Error).message)).not.toContain(TOKEN);
    await expect(run(mkFetch(() => ({ status: 200, body: page([], { schema: 2 }) })).f)).rejects.toMatchObject({ code: "schema_mismatch" });
    await expect(run(mkFetch(() => ({ status: 200, body: page([], { server: "baska" }) })).f)).rejects.toMatchObject({ code: "schema_mismatch" });
    await expect(run(mkFetch(() => ({ status: 200, body: page([{ seq: 1 }]) })).f)).rejects.toMatchObject({ code: "schema_mismatch" });
    await expect(run(mkFetch(() => ({ status: 200, body: page([], { resolution: "raw" }) })).f)).rejects.toMatchObject({ code: "schema_mismatch" });
  });
  it("agent_url kuralı: kimlik bilgisi/genel http → config hatası, ağa gidilmez", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    await expect(run(f, { srv: { ...srv, agent_url: "http://example.com" } })).rejects.toMatchObject({ code: "config" });
    expect(called).toBe(false);
  });
  it("ajan metni/etiket değerleri hata iletisine girmez", async () => {
    const { f } = mkFetch(() => ({ status: 200, body: page([{ ...item(1, NOW, "app.ws_connections", {}), max: "ENJEKSIYON\n## Baslik" }]) }));
    const e = await run(f).catch((x) => x as Error);
    expect(e.message).not.toContain("ENJEKSIYON");
  });
});
