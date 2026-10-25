// T6 kabul: hız sınırı kovaları ve trustProxy.
import { afterEach, describe, expect, it } from "vitest";
import { GOOD_TARGET, Phone, call, errCode, issueCode, pair, pairBody, passedAuth, postPair, rawHttp, rig, signHighS, type Rig } from "./auth-kit.ts";

const rigs: Rig[] = [];
const mk = (over: Parameters<typeof rig>[0] = {}) => {
  const r = rig(over);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.app.close();
});

// Yenilenme hızı çok düşük: testler duvar saatine değil sahte saate bağlıdır.
const SLOW = 1e-9;

describe("eşleşmemiş/eşleşmiş ayrı kovalar", () => {
  it("eşleşmemiş (imzasız) trafik sınırı aşınca 429 rate_limited ve retry_after_s döner", async () => {
    const r = mk({ limits: { unpaired: [5, SLOW], paired: [1000, 1000], public: [1000, 1000] } });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await r.app.inject({ method: "GET", url: GOOD_TARGET })).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes).toContain(429);
    const res = await r.app.inject({ method: "GET", url: GOOD_TARGET });
    expect(res.statusCode).toBe(429);
    expect(errCode(res.body)).toBe("rate_limited");
    expect(res.json().error.details.retry_after_s).toBeGreaterThanOrEqual(1);
  });

  it("eşleşmemiş kova tükense de eşleşmiş cihazın geçerli istekleri kabul edilir (ayrı kova)", async () => {
    const r = mk({ limits: { unpaired: [3, SLOW], paired: [1000, 1000], public: [1000, 1000] } });
    const p = await pair(r);
    for (let i = 0; i < 10; i++) await r.app.inject({ method: "GET", url: GOOD_TARGET });
    expect((await r.app.inject({ method: "GET", url: GOOD_TARGET })).statusCode).toBe(429);
    for (let i = 0; i < 20; i++) expect(passedAuth((await call(r, p, "GET", GOOD_TARGET)).statusCode), `istek ${i}`).toBe(true);
  });

  it("eşleşmiş kova tükenince eşleşmiş cihaz 429 alır; eşleşmemiş kova etkilenmez", async () => {
    const r = mk({ limits: { unpaired: [1000, 1000], paired: [4, SLOW], public: [1000, 1000] } });
    const p = await pair(r);
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await call(r, p, "GET", GOOD_TARGET)).statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes.slice(0, 4).every(passedAuth)).toBe(true);
    expect((await r.app.inject({ method: "GET", url: GOOD_TARGET })).statusCode).toBe(401);
  });

  it("bir cihazın tükenen kovası ikinci eşleşmiş cihazı etkilemez", async () => {
    const r = mk({ limits: { unpaired: [1000, 1000], paired: [3, SLOW], public: [1000, 1000] } });
    const a = await pair(r, new Phone("A"));
    const b = await pair(r, new Phone("B"));
    for (let i = 0; i < 8; i++) await call(r, a, "GET", GOOD_TARGET);
    expect((await call(r, a, "GET", GOOD_TARGET)).statusCode).toBe(429);
    expect(passedAuth((await call(r, b, "GET", GOOD_TARGET)).statusCode)).toBe(true);
  });

  it("gerçek cihaz adına atılan sahte imzalı istekler cihazın kovasını boşaltmaz", async () => {
    const r = mk({ limits: { unpaired: [1000, 1000], paired: [5, SLOW], public: [1000, 1000] } });
    const p = await pair(r);
    for (let i = 0; i < 60; i++) await call(r, p, "GET", GOOD_TARGET, undefined, { sig: signHighS });
    for (let i = 0; i < 5; i++) expect(passedAuth((await call(r, p, "GET", GOOD_TARGET)).statusCode), `istek ${i}`).toBe(true);
  });

  it("gerçek cihaz adına atılan sahte istekler eşleşmemiş kovayı tüketir (saldırgan kendi kovasında kalır)", async () => {
    const r = mk({ limits: { unpaired: [4, SLOW], paired: [1000, 1000], public: [1000, 1000] } });
    const p = await pair(r);
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await call(r, p, "GET", GOOD_TARGET, undefined, { sig: signHighS })).statusCode);
    expect(codes).toContain(429);
  });

  it("kovalar sahte saat ilerleyince dolar (yenilenme)", async () => {
    const r = mk({ limits: { unpaired: [2, 1], paired: [1000, 1000], public: [1000, 1000] } });
    for (let i = 0; i < 4; i++) await r.app.inject({ method: "GET", url: GOOD_TARGET });
    expect((await r.app.inject({ method: "GET", url: GOOD_TARGET })).statusCode).toBe(429);
    r.clock.t += 10_000;
    expect((await r.app.inject({ method: "GET", url: GOOD_TARGET })).statusCode).toBe(401);
  });

  it("varsayılan sınırlar: eşleşmemiş kova 10 denemede tükenir (varsayılan kapasite)", async () => {
    const r = mk();
    let first429 = -1;
    for (let i = 0; i < 40 && first429 < 0; i++) if ((await r.app.inject({ method: "GET", url: GOOD_TARGET })).statusCode === 429) first429 = i;
    expect(first429).toBeGreaterThan(0);
    expect(first429).toBeLessThanOrEqual(15);
  });

  it("eşleştirme denemeleri de eşleşmemiş kovadan harcanır (kaba kuvvet 429 alır)", async () => {
    const r = mk({ limits: { unpaired: [5, SLOW], paired: [1000, 1000], public: [1000, 1000] } });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await postPair(r, pairBody(`ZZZZZZZ${i % 10}`, new Phone()))).statusCode);
    expect(codes).toContain(429);
  });

  it("hız sınırına takılan (429) yanlış kod denemeleri kodu yakmaz: sınır açılınca doğru kod hâlâ geçerlidir", async () => {
    const r = mk({ limits: { unpaired: [2, 1], paired: [1000, 1000], public: [1000, 1000] } });
    const code = issueCode(r);
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await postPair(r, pairBody(`ZZZZZZZ${i}`, new Phone()))).statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(6);
    r.clock.t += 10_000;
    expect((await postPair(r, pairBody(code, new Phone()))).statusCode).toBe(200);
  });

  it("/health kendi kovasında sınırlanır ve auth kovalarını tüketmez", async () => {
    const r = mk({ limits: { unpaired: [1000, 1000], paired: [1000, 1000], public: [3, SLOW] } });
    const p = await pair(r);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await r.app.inject({ method: "GET", url: "/v1/health" })).statusCode);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes).toContain(429);
    expect(passedAuth((await call(r, p, "GET", GOOD_TARGET)).statusCode)).toBe(true);
  });
});

describe("trustProxy: loopback", () => {
  const xff = (i: number, right = "203.0.113.9") => ({ "x-forwarded-for": `10.0.${i % 250}.${i % 250}, ${right}` });

  it("sahte sol X-Forwarded-For girdisini her istekte değiştirmek eşleşmemiş kovayı aşamaz", async () => {
    const r = mk({ trustProxy: "loopback", limits: { unpaired: [5, SLOW], paired: [1000, 1000], public: [1000, 1000] } });
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) codes.push((await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: xff(i) })).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
  });

  it("farklı sağ girdi (proxy'nin eklediği gerçek istemci) ayrı kova alır", async () => {
    const r = mk({ trustProxy: "loopback", limits: { unpaired: [3, SLOW], paired: [1000, 1000], public: [1000, 1000] } });
    for (let i = 0; i < 8; i++) await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: xff(i, "203.0.113.9") });
    expect((await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: xff(0, "203.0.113.9") })).status).toBe(429);
    expect((await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: xff(0, "203.0.113.77") })).status).toBe(401);
  });

  it("sahte sol girdi eşleştirme (kaba kuvvet) kovasını da aşamaz", async () => {
    const r = mk({ trustProxy: "loopback", limits: { unpaired: [4, SLOW], paired: [1000, 1000], public: [1000, 1000] } });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await rawHttp(r.app, { method: "POST", target: "/v1/pair", headers: { ...xff(i), "content-type": "application/json" }, body: pairBody(`ZZZZZZZ${i % 10}`, new Phone()) });
      codes.push(res.status);
    }
    expect(codes).toContain(429);
  });

  it("sahte sol girdi /health kovasını da aşamaz", async () => {
    const r = mk({ trustProxy: "loopback", limits: { unpaired: [1000, 1000], paired: [1000, 1000], public: [3, SLOW] } });
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await rawHttp(r.app, { method: "GET", target: "/v1/health", headers: xff(i) })).status);
    expect(codes).toContain(429);
  });

  it("tek girişli sahte X-Forwarded-For (ör. 1.2.3.4) kovayı değiştirmez; yerel proxy kendi girdisini ekler", async () => {
    const r = mk({ trustProxy: "loopback", limits: { unpaired: [3, SLOW], paired: [1000, 1000], public: [1000, 1000] } });
    const codes: number[] = [];
    // Proxy sağa gerçek istemciyi ekler; istemcinin yazdığı soldaki dizi değişse de sağ girdi sabit.
    for (let i = 0; i < 10; i++) codes.push((await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: { "x-forwarded-for": `${i}.${i}.${i}.${i}, 198.51.100.5` } })).status);
    expect(codes).toContain(429);
  });

  it("trustProxy kapalıyken (varsayılan) X-Forwarded-For hiç dikkate alınmaz", async () => {
    const r = mk({ limits: { unpaired: [3, SLOW], paired: [1000, 1000], public: [1000, 1000] } });
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: xff(i, `203.0.113.${i}`) })).status);
    expect(codes).toContain(429);
  });

  it("X-Forwarded-For eşleşmiş cihazın kovasını değiştirmez (kova cihaz kimliğine bağlı)", async () => {
    const r = mk({ trustProxy: "loopback", limits: { unpaired: [1000, 1000], paired: [3, SLOW], public: [1000, 1000] } });
    const p = await pair(r);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const h = { ...p.headers(r.clock, "GET", GOOD_TARGET), ...xff(i, `198.51.100.${i}`) };
      codes.push((await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: h })).status);
    }
    expect(codes).toContain(429);
  });

  it("bozuk X-Forwarded-For değeri sunucuyu çökertmez ve istek imzasızsa 401/429 alır", async () => {
    const r = mk({ trustProxy: "loopback", limits: { unpaired: [1000, 1000], paired: [1000, 1000], public: [1000, 1000] } });
    for (const v of ["", "garbage", ",,,", "999.999.999.999", "::ffff:1.2.3.4, ::1", "a".repeat(2000)]) {
      const res = await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: { "x-forwarded-for": v } });
      expect([401, 429], JSON.stringify(v).slice(0, 20)).toContain(res.status);
    }
  });
});
