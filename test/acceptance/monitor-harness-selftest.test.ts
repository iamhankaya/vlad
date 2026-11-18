// monitor-kabul harness öz-sınaması (T20261119-21): sahte ajan gerçek spc davranışını (imleç, 401, 410, sayfalama) doğru taklit ediyor mu?
// Üretim koduna bağımlı değil; kabul testlerinin kırmızısının harness hatasından değil eksik uygulamadan geldiğini kanıtlar.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAlertsResponse } from "../../src/monitor/contract.js";
import { FakeAgent, TOKEN, alertItem, fixture, throwsReal } from "./monitor-harness.js";

let a: FakeAgent;
beforeEach(async () => { a = await new FakeAgent().start(); });
afterEach(async () => { await a.stop(); });
const get = (qs = "", token = TOKEN) => fetch(`${a.url}/spc/v1/alerts${qs}`, { headers: { authorization: `Bearer ${token}` } });

describe("monitor harness öz-sınaması", () => {
  it("yanıt vendored şemaya uyar; imleç sonrası yalnız yeni seq'ler gelir", async () => {
    const x = a.upsert(alertItem());
    const r1 = parseAlertsResponse(await (await get("?state=all")).json(), "medialog");
    expect(r1.items.map((i) => i.alert_id)).toEqual([x.alert_id]);
    const r2 = parseAlertsResponse(await (await get(`?cursor=${r1.next_cursor}`)).json(), "medialog");
    expect(r2.items).toEqual([]);
    a.resolve(x.alert_id);
    const r3 = parseAlertsResponse(await (await get(`?cursor=${r2.next_cursor}`)).json(), "medialog");
    expect(r3.items.map((i) => i.state)).toEqual(["resolved"]);
  });
  it("limit → has_more ve sayfa 2", async () => {
    for (let i = 0; i < 3; i++) a.upsert(alertItem({ rule_id: `r-${i}` }));
    const p1 = await (await get("?limit=2")).json() as { items: unknown[]; has_more: boolean; next_cursor: string };
    expect(p1.items).toHaveLength(2);
    expect(p1.has_more).toBe(true);
    const p2 = await (await get(`?limit=2&cursor=${p1.next_cursor}`)).json() as { items: unknown[]; has_more: boolean };
    expect(p2.items).toHaveLength(1);
    expect(p2.has_more).toBe(false);
  });
  it("yanlış belirteç 401; epoch değişince eski imleç 410", async () => {
    expect((await get("", "yanlis")).status).toBe(401);
    a.upsert(alertItem());
    const r = await (await get()).json() as { next_cursor: string };
    a.resetEpoch();
    expect((await get(`?cursor=${r.next_cursor}`)).status).toBe(410);
  });
  it("fixture yanıtları şemaya uyar ve 401/410 fixture'ları spc hata biçiminde", () => {
    for (const f of ["alerts-critical-firing.json", "alerts-critical-resolved.json", "alerts-critical-suppressed.json", "alerts-warning-info-firing.json", "alerts-page1-has-more.json", "alerts-page2-last.json"]) {
      expect(() => parseAlertsResponse(fixture(f), "medialog")).not.toThrow();
    }
    expect(fixture<{ status: number }>("error-401-unauthorized.json").status).toBe(401);
    expect(fixture<{ status: number }>("error-410-cursor-invalid.json").status).toBe(410);
  });
  it("throwsReal: iskelet hatasını geçerli saymaz, gerçek hatayı sayar", () => {
    expect(() => throwsReal(() => { throw new Error("not implemented: x"); })).toThrow(/iskelet/);
    expect(() => throwsReal(() => { throw new Error("geçersiz proje"); }, /proje/)).not.toThrow();
    expect(() => throwsReal(() => undefined)).toThrow(/bekleniyordu/);
  });
});
