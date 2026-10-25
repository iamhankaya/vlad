// T6 kabul: tekrar (replay) ve nonce tüketimi.
import { afterEach, describe, expect, it } from "vitest";
import { GOOD_TARGET, call, newNonce, pair, passedAuth, rig, signHighS, type Rig } from "./auth-kit.ts";

const rigs: Rig[] = [];
const mk = (over: Parameters<typeof rig>[0] = {}) => {
  const r = rig({ limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] }, ...over });
  rigs.push(r);
  return r;
};
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.app.close();
});

describe("nonce tekrarı", () => {
  it("aynı istek (aynı zarf, aynı başlıklar) ikinci kez gönderilirse 401", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "GET", GOOD_TARGET);
    const first = await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h });
    expect(passedAuth(first.statusCode)).toBe(true);
    const second = await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h });
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe("unauthorized");
  });

  it("aynı nonce ile yeniden imzalanmış farklı bir istek (başka yol, başka ts) de reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    const nonce = newNonce();
    expect(passedAuth((await call(r, p, "GET", "/v1/home", undefined, { nonce })).statusCode)).toBe(true);
    r.clock.t += 5_000;
    expect((await call(r, p, "GET", "/v1/projects", undefined, { nonce })).statusCode).toBe(401);
  });

  it("POST gövdesi aynı kalsa da tekrar gönderilen imzalı POST ikinci kez 401 alır", async () => {
    const r = mk();
    const p = await pair(r);
    const body = '{"message":"merhaba"}';
    const h = p.headers(r.clock, "POST", "/v1/chat", body);
    const send = () => r.app.inject({ method: "POST", url: "/v1/chat", headers: { ...h, "content-type": "application/json" }, payload: body });
    expect(passedAuth((await send()).statusCode)).toBe(true);
    expect((await send()).statusCode).toBe(401);
  });

  it("yeniden başlatma sonrası daha önce kabul edilmiş aynı istek 401 alır (nonce diskte)", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "GET", GOOD_TARGET);
    expect(passedAuth((await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })).statusCode)).toBe(true);
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    expect((await r2.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })).statusCode).toBe(401);
  });

  it("yeniden başlatma sonrası cihaz hâlâ eşleşik ve yeni nonce'lu istek kabul edilir", async () => {
    const r = mk();
    const p = await pair(r);
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    expect(passedAuth((await call(r2, p, "GET", GOOD_TARGET)).statusCode)).toBe(true);
  });

  it("iki kez yeniden başlatılsa da ilk kabul edilen nonce yine reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "GET", GOOD_TARGET);
    await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h });
    await r.app.close();
    const r2 = r.restart();
    await r2.app.close();
    const r3 = r.restart();
    rigs.push(r3);
    expect((await r3.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })).statusCode).toBe(401);
  });

  it("geçersiz imzalı istek nonce'u tüketmez: aynı nonce ile sonradan atılan geçerli istek kabul edilir", async () => {
    const r = mk();
    const p = await pair(r);
    const nonce = newNonce();
    expect((await call(r, p, "GET", GOOD_TARGET, undefined, { nonce, sig: signHighS })).statusCode).toBe(401);
    expect(passedAuth((await call(r, p, "GET", GOOD_TARGET, undefined, { nonce })).statusCode)).toBe(true);
  });

  it("geçersiz imzalı istek (bilinmeyen cihaz adına) nonce'u tüketmez", async () => {
    const r = mk();
    const p = await pair(r);
    const nonce = newNonce();
    expect((await call(r, p, "GET", GOOD_TARGET, undefined, { nonce, device: "intruder" })).statusCode).toBe(401);
    expect(passedAuth((await call(r, p, "GET", GOOD_TARGET, undefined, { nonce })).statusCode)).toBe(true);
  });

  it("zaman penceresi dışı (ama imzası geçerli) istek nonce'u tüketmez", async () => {
    const r = mk();
    const p = await pair(r);
    const nonce = newNonce();
    expect((await call(r, p, "GET", GOOD_TARGET, undefined, { nonce, ts: r.clock.t - 500_000 })).statusCode).toBe(401);
    expect(passedAuth((await call(r, p, "GET", GOOD_TARGET, undefined, { nonce })).statusCode)).toBe(true);
  });

  it("tüketilmemiş nonce yeniden başlatmadan sonra da kullanılabilir (reddedilen istek diske yazılmaz)", async () => {
    const r = mk();
    const p = await pair(r);
    const nonce = newNonce();
    await call(r, p, "GET", GOOD_TARGET, undefined, { nonce, sig: signHighS });
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    expect(passedAuth((await call(r2, p, "GET", GOOD_TARGET, undefined, { nonce })).statusCode)).toBe(true);
  });

  it("çok sayıda geçersiz imzalı istek sonrası (nonce önbelleği şişmez) geçerli istekler hâlâ kabul edilir ve yeniden başlatma sorunsuzdur", async () => {
    const r = mk();
    const p = await pair(r);
    for (let i = 0; i < 300; i++) await call(r, p, "GET", GOOD_TARGET, undefined, { sig: signHighS });
    expect(passedAuth((await call(r, p, "GET", GOOD_TARGET)).statusCode)).toBe(true);
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    expect(passedAuth((await call(r2, p, "GET", GOOD_TARGET)).statusCode)).toBe(true);
  });

  it("kabul edilen çok sayıda farklı nonce sonrası ilk nonce hâlâ reddedilir (önbellek en eskiyi atmaz)", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "GET", GOOD_TARGET);
    await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h });
    for (let i = 0; i < 500; i++) await call(r, p, "GET", GOOD_TARGET);
    expect((await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })).statusCode).toBe(401);
  });

  it("iki eşzamanlı özdeş istekten yalnız biri kabul edilir", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "GET", GOOD_TARGET);
    const results = await Promise.all(Array.from({ length: 8 }, () => r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })));
    expect(results.filter((x) => passedAuth(x.statusCode))).toHaveLength(1);
    expect(results.filter((x) => x.statusCode === 401)).toHaveLength(7);
  });

  it("aynı istek pencere içinde saat ilerlese de tekrar kabul edilmez", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "GET", GOOD_TARGET);
    await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h });
    r.clock.t += 100_000;
    expect((await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })).statusCode).toBe(401);
  });
});
