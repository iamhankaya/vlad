// T6 kabul: cihaz iptali ve approval (session+approval) uçlarının cihaz/anahtar bağlama negatifleri.
import { afterEach, describe, expect, it } from "vitest";
import { GOOD_TARGET, Phone, call, errCode, genKey, newNonce, pair, passedAuth, revokeText, rig, signHighS, signLowS, signRawRS, type Rig } from "./auth-kit.ts";

const rigs: Rig[] = [];
const mk = (over: Parameters<typeof rig>[0] = {}) => {
  const r = rig({ limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] }, ...over });
  rigs.push(r);
  return r;
};
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.app.close();
});

/** Çağıran cihaz `by`, hedef `target`; imza/gövde alanları ayrı ayrı bozulabilir. */
function revokeCall(
  r: Rig,
  by: Phone,
  target: string,
  o: { ts?: number; bodyTs?: number; signer?: string; key?: Phone["approval"]["priv"]; sig?: typeof signLowS; header?: Partial<Parameters<Phone["headers"]>[4]>; body?: Record<string, unknown> } = {},
) {
  const ts = o.ts ?? r.clock.t;
  const bodyTs = o.bodyTs ?? ts;
  const sigFn = o.sig ?? signLowS;
  const signature = sigFn(o.key ?? by.approval.priv, revokeText(target, o.signer ?? by.id, bodyTs));
  const body = JSON.stringify(o.body ?? { ts_ms: bodyTs, signature });
  return call(r, by, "POST", `/v1/devices/${target}/revoke`, body, { ts, ...(o.header ?? {}) });
}

const trio = async (r: Rig) => ({ a: await pair(r, new Phone("A")), b: await pair(r, new Phone("B")), c: await pair(r, new Phone("C")) });
const alive = async (r: Rig, p: Phone) => passedAuth((await call(r, p, "GET", GOOD_TARGET)).statusCode);

describe("iptal sonrası", () => {
  it("iptal edilen cihazın session isteği 401 alır (device_revoked ya da unauthorized)", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    expect(await alive(r, b)).toBe(true);
    expect((await revokeCall(r, a, b.id)).statusCode).toBe(200);
    const res = await call(r, b, "GET", GOOD_TARGET);
    expect(res.statusCode).toBe(401);
    expect(["device_revoked", "unauthorized"]).toContain(errCode(res.body));
  });

  it("iptal edilen cihazın session+approval uçlarına isteği (approve) 401 alır", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    await revokeCall(r, a, b.id);
    const res = await call(r, b, "POST", "/v1/actions/A-test/approve", JSON.stringify({ signature: signLowS(b.approval.priv, "x") }));
    expect(res.statusCode).toBe(401);
  });

  it("iptal edilen cihaz başka bir cihazı iptal edemez (devir yetkisi de yok)", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    await revokeCall(r, a, b.id);
    const res = await revokeCall(r, b, c.id);
    expect(res.statusCode).toBe(401);
    expect(await alive(r, c)).toBe(true);
  });

  it("iptal yeniden başlatma sonrası da geçerlidir", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    await revokeCall(r, a, b.id);
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    expect((await call(r2, b, "GET", GOOD_TARGET)).statusCode).toBe(401);
    expect(await alive(r2, a)).toBe(true);
  });

  it("iptal yalnız hedefi etkiler; iptal eden ve üçüncü cihaz çalışmaya devam eder", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    await revokeCall(r, a, b.id);
    expect(await alive(r, a)).toBe(true);
    expect(await alive(r, c)).toBe(true);
  });

  it("iptal edilmiş cihaz kimliği imzalı geçerli bir istekle bile geri dönmez (aynı istek tekrar)", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    const h = b.headers(r.clock, "GET", GOOD_TARGET);
    await revokeCall(r, a, b.id);
    expect((await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })).statusCode).toBe(401);
  });

  it("iptal edilen cihazın anahtarı yeni eşleştirmede yeniden kullanılamaz", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    await revokeCall(r, a, b.id);
    const { issueCode, postPair, pairBody } = await import("./auth-kit.ts");
    expect((await postPair(r, pairBody(issueCode(r), new Phone("B2", b.session, genKey())))).statusCode).toBe(400);
  });

  it("kendini iptal eden cihaz sonrasında 401 alır", async () => {
    const r = mk();
    const { a } = await trio(r);
    expect((await revokeCall(r, a, a.id)).statusCode).toBe(200);
    expect((await call(r, a, "GET", GOOD_TARGET)).statusCode).toBe(401);
  });
});

describe("iptal imzası bağlama", () => {
  it("başka cihazın approval anahtarıyla atılmış iptal imzası 401 (hedef yaşamaya devam eder)", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    const res = await revokeCall(r, a, b.id, { key: c.approval.priv });
    expect(res.statusCode).toBe(401);
    expect(await alive(r, b)).toBe(true);
  });

  it("çağıran cihazın session anahtarıyla imzalanmış iptal 401", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    expect((await revokeCall(r, a, b.id, { key: a.session.priv })).statusCode).toBe(401);
    expect(await alive(r, b)).toBe(true);
  });

  it("imza metnindeki signer başlıktaki X-Vlad-Device'tan farklıysa 401 (C adına imzalı metin A'dan gelir)", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    expect((await revokeCall(r, a, b.id, { signer: c.id, key: c.approval.priv })).statusCode).toBe(401);
    expect(await alive(r, b)).toBe(true);
  });

  it("A, C'nin approval anahtarıyla C imzalı iptali C kimliğiyle sunamaz (başlık A, imza C)", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    const ts = r.clock.t;
    const body = JSON.stringify({ ts_ms: ts, signature: signLowS(c.approval.priv, revokeText(b.id, c.id, ts)) });
    const res = await call(r, a, "POST", `/v1/devices/${b.id}/revoke`, body, { ts });
    expect(res.statusCode).toBe(401);
    expect(await alive(r, b)).toBe(true);
  });

  it("imza başka hedef için atılmışsa (hedef değişmiş) 401", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    const ts = r.clock.t;
    const body = JSON.stringify({ ts_ms: ts, signature: signLowS(a.approval.priv, revokeText(c.id, a.id, ts)) });
    expect((await call(r, a, "POST", `/v1/devices/${b.id}/revoke`, body, { ts })).statusCode).toBe(401);
    expect(await alive(r, b)).toBe(true);
    expect(await alive(r, c)).toBe(true);
  });

  it("gövdedeki ts_ms ile X-Vlad-Ts eşit değilse 401 (imza gövde ts'sine uygun olsa da)", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    const res = await revokeCall(r, a, b.id, { ts: r.clock.t, bodyTs: r.clock.t - 1000 });
    expect(res.statusCode).toBe(401);
    expect(await alive(r, b)).toBe(true);
  });

  it("imza ts'si ile gövde ts_ms'i farklıysa 401", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    const ts = r.clock.t;
    const body = JSON.stringify({ ts_ms: ts, signature: signLowS(a.approval.priv, revokeText(b.id, a.id, ts - 1)) });
    expect((await call(r, a, "POST", `/v1/devices/${b.id}/revoke`, body, { ts })).statusCode).toBe(401);
  });

  it("yüksek-S approval imzası 401", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    expect((await revokeCall(r, a, b.id, { sig: signHighS })).statusCode).toBe(401);
    expect(await alive(r, b)).toBe(true);
  });

  it("ham r||s approval imzası 401", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    expect((await revokeCall(r, a, b.id, { sig: signRawRS })).statusCode).toBe(401);
  });

  it("pencere dışı ts (-121 sn, gövde ve başlık eşit) 401; -120 sn kabul", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    expect((await revokeCall(r, a, b.id, { ts: r.clock.t - 121_000 })).statusCode).toBe(401);
    expect(await alive(r, b)).toBe(true);
    expect((await revokeCall(r, a, c.id, { ts: r.clock.t - 120_000 })).statusCode).toBe(200);
  });

  it("pencere dışı ts (+121 sn) 401", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    expect((await revokeCall(r, a, b.id, { ts: r.clock.t + 121_000 })).statusCode).toBe(401);
  });

  it("(signer, ts) tek kullanım: aynı ts ile ikinci cihazı iptal etme denemesi 401, ikinci cihaz çalışır", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    const ts = r.clock.t;
    expect((await revokeCall(r, a, b.id, { ts })).statusCode).toBe(200);
    const second = await revokeCall(r, a, c.id, { ts });
    expect(second.statusCode).toBe(401);
    expect(await alive(r, c)).toBe(true);
  });

  it("(signer, ts) tekrarı yeniden başlatma sonrası da reddedilir", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    const ts = r.clock.t;
    await revokeCall(r, a, b.id, { ts });
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    expect((await revokeCall(r2, a, c.id, { ts })).statusCode).toBe(401);
    expect(await alive(r2, c)).toBe(true);
  });

  it("farklı ts ile ikinci iptal kabul edilir (tekillik yalnız (signer, ts) çiftinde)", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    expect((await revokeCall(r, a, b.id, { ts: r.clock.t })).statusCode).toBe(200);
    expect((await revokeCall(r, a, c.id, { ts: r.clock.t + 1 })).statusCode).toBe(200);
  });

  it("farklı iptal edenler aynı ts'yi kullanabilir (tekillik signer başınadır)", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    const d = await pair(r, new Phone("D"));
    const ts = r.clock.t;
    expect((await revokeCall(r, a, b.id, { ts })).statusCode).toBe(200);
    expect((await revokeCall(r, c, d.id, { ts })).statusCode).toBe(200);
  });

  it("zarf nonce'u tekrar kullanılırsa iptal isteği de 401 (zarf katmanı iptalde de geçerli)", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    const nonce = newNonce();
    expect((await revokeCall(r, a, b.id, { ts: r.clock.t, header: { nonce } })).statusCode).toBe(200);
    expect((await revokeCall(r, a, c.id, { ts: r.clock.t + 1, header: { nonce } })).statusCode).toBe(401);
  });

  it("birebir tekrarlanan iptal isteği 401 (zarf ve (signer, ts) tekrarı)", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    const ts = r.clock.t;
    const body = JSON.stringify({ ts_ms: ts, signature: signLowS(a.approval.priv, revokeText(b.id, a.id, ts)) });
    const h = a.headers(r.clock, "POST", `/v1/devices/${b.id}/revoke`, body, { ts });
    const send = () => r.app.inject({ method: "POST", url: `/v1/devices/${b.id}/revoke`, headers: { ...h, "content-type": "application/json" }, payload: body });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(401);
  });

  it("gövdede ek alan (device, signer, device_id) 400 alır ve iptal gerçekleşmez", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    const ts = r.clock.t;
    const signature = signLowS(a.approval.priv, revokeText(b.id, a.id, ts));
    for (const extra of [{ device: b.id }, { signer: a.id }, { device_id: b.id }]) {
      const res = await revokeCall(r, a, b.id, { body: { ts_ms: ts, signature, ...extra }, ts, header: { nonce: newNonce() } });
      expect([400, 401], JSON.stringify(extra)).toContain(res.statusCode);
    }
    expect(await alive(r, b)).toBe(true);
  });

  it("gövdede signature eksik ya da ts_ms eksik/yanlış tipteyse 400 (iptal olmaz)", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    const ts = r.clock.t;
    const signature = signLowS(a.approval.priv, revokeText(b.id, a.id, ts));
    for (const body of [{ ts_ms: ts }, { signature }, { ts_ms: String(ts), signature }, { ts_ms: ts + 0.5, signature }, {}]) {
      const res = await revokeCall(r, a, b.id, { body, ts, header: { nonce: newNonce() } });
      expect([400, 401], JSON.stringify(body)).toContain(res.statusCode);
    }
    expect(await alive(r, b)).toBe(true);
  });

  it("gövde JSON değilse 400/401 ve iptal olmaz", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    const res = await call(r, a, "POST", `/v1/devices/${b.id}/revoke`, "not json");
    expect([400, 401]).toContain(res.statusCode);
    expect(await alive(r, b)).toBe(true);
  });

  it("session imzası eksik (yalnız gövde imzalı, başlıklar yok) iptal isteği 401", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    const ts = r.clock.t;
    const body = JSON.stringify({ ts_ms: ts, signature: signLowS(a.approval.priv, revokeText(b.id, a.id, ts)) });
    const res = await r.app.inject({ method: "POST", url: `/v1/devices/${b.id}/revoke`, headers: { "content-type": "application/json" }, payload: body });
    expect(res.statusCode).toBe(401);
    expect(await alive(r, b)).toBe(true);
  });

  it("geçerli approval imzası ama kötü session zarfı imzası (yüksek-S) iptali yapmaz", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    const res = await revokeCall(r, a, b.id, { header: { sig: signHighS } });
    expect(res.statusCode).toBe(401);
    expect(await alive(r, b)).toBe(true);
  });

  it("A'nın session anahtarı yerine B'nin session anahtarıyla imzalı zarf + A'nın geçerli approval imzası 401", async () => {
    const r = mk();
    const { a, b, c } = await trio(r);
    const res = await revokeCall(r, a, c.id, { header: { key: b.session.priv } });
    expect(res.statusCode).toBe(401);
    expect(await alive(r, c)).toBe(true);
  });
});

describe("bilinmeyen hedef imzadan önce sızmaz", () => {
  it("geçersiz imzayla bilinmeyen hedef ile bilinen hedef aynı yanıtı verir (401, aynı gövde)", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    const known = await revokeCall(r, a, b.id, { sig: signHighS });
    const unknown = await revokeCall(r, a, "no-such-device", { sig: signHighS });
    expect(known.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toBe(known.body);
  });

  it("approval imzası olmayan bilinmeyen hedef de 404 değil 401 verir", async () => {
    const r = mk();
    const { a } = await trio(r);
    const ts = r.clock.t;
    const res = await call(r, a, "POST", "/v1/devices/ghost/revoke", JSON.stringify({ ts_ms: ts, signature: "AAAA" }), { ts });
    expect(res.statusCode).toBe(401);
  });

  it("başkasının approval anahtarıyla imzalı bilinmeyen hedef 404 değil 401 verir", async () => {
    const r = mk();
    const { a, c } = await trio(r);
    expect((await revokeCall(r, a, "ghost", { key: c.approval.priv })).statusCode).toBe(401);
  });

  it("imzasız istek bilinmeyen ve bilinen hedef için aynı 401 gövdesini verir", async () => {
    const r = mk();
    const { b } = await trio(r);
    const x = await r.app.inject({ method: "POST", url: `/v1/devices/${b.id}/revoke`, headers: { "content-type": "application/json" }, payload: "{}" });
    const y = await r.app.inject({ method: "POST", url: "/v1/devices/ghost/revoke", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(x.statusCode).toBe(401);
    expect(y.statusCode).toBe(401);
    expect(x.body).toBe(y.body);
  });

  it("geçerli imzayla bilinmeyen hedef yalnızca 404 verir (yan etki yok)", async () => {
    const r = mk();
    const { a, b } = await trio(r);
    expect((await revokeCall(r, a, "ghost")).statusCode).toBe(404);
    expect(await alive(r, a)).toBe(true);
    expect(await alive(r, b)).toBe(true);
  });
});

describe("session+approval uçlarında approval anahtarı bağlama", () => {
  it("approve: imzasız (yalnız gövde) çağrı 401", async () => {
    const r = mk();
    const res = await r.app.inject({ method: "POST", url: "/v1/actions/A-1/approve", headers: { "content-type": "application/json" }, payload: JSON.stringify({ signature: "AAAA" }) });
    expect(res.statusCode).toBe(401);
  });

  it("grant oluştur: imzasız çağrı 401", async () => {
    const r = mk();
    const res = await r.app.inject({ method: "POST", url: "/v1/grants", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(401);
  });
});
