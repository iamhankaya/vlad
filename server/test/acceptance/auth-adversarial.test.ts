// T6 kabul: sözleşmede açık yazılmayan ama güvenlik açısından beklenen sağlamlık (prototip anahtarları, cihaz kimliği biçimi, yarışlar).
import { afterEach, describe, expect, it } from "vitest";
import { GOOD_TARGET, Phone, call, genKey, issueCode, newNonce, pair, pairBody, passedAuth, postPair, revokeText, rig, signLowS, type Rig } from "./auth-kit.ts";

const rigs: Rig[] = [];
const mk = () => {
  const r = rig({ limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] } });
  rigs.push(r);
  return r;
};
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.app.close();
});

const PROTO = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"];

describe("prototip anahtarları", () => {
  for (const id of PROTO) {
    it(`X-Vlad-Device: ${id} → 401 (cihaz defteri prototipten cihaz üretmez)`, async () => {
      const r = mk();
      const p = await pair(r);
      const res = await call(r, p, "GET", GOOD_TARGET, undefined, { device: id });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    });
  }

  it("device_name prototip anahtarıyla eşleşme, cihaz kimliği geçerli biçimde döner ve cihaz çalışır", async () => {
    const r = mk();
    for (const n of PROTO) {
      const p = await pair(r, new Phone(n));
      expect(p.id).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      expect(passedAuth((await call(r, p, "GET", GOOD_TARGET)).statusCode), n).toBe(true);
    }
  });

  it("eşleştirme gövdesinde __proto__ anahtarı 400 alır", async () => {
    const r = mk();
    const p = new Phone();
    const raw = `{"code":"${issueCode(r)}","device_name":"x","session_pub":"${p.session.pub}","approval_pub":"${p.approval.pub}","__proto__":{"admin":true}}`;
    expect((await postPair(r, raw)).statusCode).toBe(400);
  });

  it("iptal hedefi prototip anahtarı olan geçerli imzalı istek 404 alır (yan etki yok)", async () => {
    const r = mk();
    const a = await pair(r);
    for (const t of PROTO) {
      const ts = r.clock.t++;
      const body = JSON.stringify({ ts_ms: ts, signature: signLowS(a.approval.priv, revokeText(t, a.id, ts)) });
      const res = await call(r, a, "POST", `/v1/devices/${t}/revoke`, body, { ts });
      expect(res.statusCode, t).toBe(404);
    }
    expect(passedAuth((await call(r, a, "GET", GOOD_TARGET)).statusCode)).toBe(true);
  });
});

describe("cihaz kimliği biçimi", () => {
  const names = [".", "..", "a/b", "../../etc/passwd", "ünï", "😀 Telefon", " ", "a b", "<script>alert(1)</script>", "x".repeat(64), "A".repeat(64), "%2e%2e", "a?b#c", "C:\\temp", "NUL", "a;b"];
  for (const name of names) {
    it(`device_name ${JSON.stringify(name).slice(0, 30)} → geçerli, yol-güvenli device_id`, async () => {
      const r = mk();
      const p = await pair(r, new Phone(name));
      expect(p.id).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      expect([".", ".."]).not.toContain(p.id);
      // kimlik yol parçası olarak güvenle kullanılabilir
      const other = await pair(r, new Phone("Diğer"));
      const ts = r.clock.t;
      const body = JSON.stringify({ ts_ms: ts, signature: signLowS(other.approval.priv, revokeText(p.id, other.id, ts)) });
      expect((await call(r, other, "POST", `/v1/devices/${encodeURIComponent(p.id)}/revoke`, body, { ts })).statusCode).toBe(200);
      expect((await call(r, p, "GET", GOOD_TARGET)).statusCode).toBe(401);
    });
  }

  it("aynı device_name'li çok sayıda cihaz birbirinin kimliğini ezmez", async () => {
    const r = mk();
    const phones = [];
    for (let i = 0; i < 6; i++) phones.push(await pair(r, new Phone("Pixel 9")));
    expect(new Set(phones.map((p) => p.id)).size).toBe(6);
    const [first, ...rest] = phones;
    const ts = r.clock.t;
    const body = JSON.stringify({ ts_ms: ts, signature: signLowS(first!.approval.priv, revokeText(rest[0]!.id, first!.id, ts)) });
    expect((await call(r, first!, "POST", `/v1/devices/${rest[0]!.id}/revoke`, body, { ts })).statusCode).toBe(200);
    for (const p of [first!, ...rest.slice(1)]) expect(passedAuth((await call(r, p, "GET", GOOD_TARGET)).statusCode)).toBe(true);
  });

  it("yeniden başlatma sonrası yeni eşleşen cihaz eskinin kimliğini yeniden kullanmaz", async () => {
    const r = mk();
    const a = await pair(r, new Phone("Pixel 9"));
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    const b = await pair(r2, new Phone("Pixel 9"));
    expect(b.id).not.toBe(a.id);
    expect(passedAuth((await call(r2, a, "GET", GOOD_TARGET)).statusCode)).toBe(true);
    expect(passedAuth((await call(r2, b, "GET", GOOD_TARGET)).statusCode)).toBe(true);
  });
});

describe("yarışlar", () => {
  it("aynı anahtarla eşzamanlı iki eşleştirme (iki ayrı kod) en çok bir cihaz kaydeder", async () => {
    const r = mk();
    const k = { s: genKey(), a: genKey() };
    const results = await Promise.all(
      [issueCode(r), issueCode(r)].map((code, i) => postPair(r, pairBody(code, new Phone(`Tel ${i}`, k.s, k.a)))),
    );
    expect(results.filter((x) => x.statusCode === 200).length).toBeLessThanOrEqual(1);
  });

  it("aynı (signer, ts) ile eşzamanlı iki iptal isteğinden yalnız biri uygulanır", async () => {
    const r = mk();
    const a = await pair(r, new Phone("A"));
    const b = await pair(r, new Phone("B"));
    const c = await pair(r, new Phone("C"));
    const ts = r.clock.t;
    const send = (target: Phone) => {
      const body = JSON.stringify({ ts_ms: ts, signature: signLowS(a.approval.priv, revokeText(target.id, a.id, ts)) });
      return call(r, a, "POST", `/v1/devices/${target.id}/revoke`, body, { ts, nonce: newNonce() });
    };
    const res = await Promise.all([send(b), send(c)]);
    expect(res.filter((x) => x.statusCode === 200)).toHaveLength(1);
    const states = await Promise.all([b, c].map(async (p) => passedAuth((await call(r, p, "GET", GOOD_TARGET)).statusCode)));
    expect(states.filter(Boolean)).toHaveLength(1);
  });

  it("aynı hedefe eşzamanlı iki iptal (farklı ts) tutarlı biçimde biter, sunucu 5xx vermez", async () => {
    const r = mk();
    const a = await pair(r, new Phone("A"));
    const b = await pair(r, new Phone("B"));
    const send = (ts: number) => {
      const body = JSON.stringify({ ts_ms: ts, signature: signLowS(a.approval.priv, revokeText(b.id, a.id, ts)) });
      return call(r, a, "POST", `/v1/devices/${b.id}/revoke`, body, { ts });
    };
    const res = await Promise.all([send(r.clock.t), send(r.clock.t + 1), send(r.clock.t + 2)]);
    for (const x of res) expect(x.statusCode).toBeLessThan(500);
    expect((await call(r, b, "GET", GOOD_TARGET)).statusCode).toBe(401);
  });

  it("eşzamanlı 30 farklı imzalı istek hepsi kabul edilir (nonce deposu eşzamanlılıkta kayıp vermez), yeniden gönderimleri reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    const reqs = Array.from({ length: 30 }, () => p.headers(r.clock, "GET", GOOD_TARGET));
    const first = await Promise.all(reqs.map((h) => r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })));
    expect(first.every((x) => passedAuth(x.statusCode))).toBe(true);
    const again = await Promise.all(reqs.map((h) => r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })));
    expect(again.every((x) => x.statusCode === 401)).toBe(true);
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    const afterRestart = await Promise.all(reqs.map((h) => r2.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })));
    expect(afterRestart.every((x) => x.statusCode === 401)).toBe(true);
  });
});
