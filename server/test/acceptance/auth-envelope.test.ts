// T6 kabul: zarf/imza negatifleri (yalnız HTTP arayüzünden). Kaynak: contract/README.md, openapi.yaml, signing-vectors.json (v2).
import { afterEach, describe, expect, it } from "vitest";
import {
  Clock, GOOD_TARGET, Phone, b64u, call, envelope, errCode, genKey, newNonce, pair, passedAuth, rawHttp, rig, signHighS, signLowS, signRawRS, vectors,
  type Rig,
} from "./auth-kit.ts";

const rigs: Rig[] = [];
const mk = (over: Parameters<typeof rig>[0] = {}) => {
  const r = rig({ limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] }, ...over });
  rigs.push(r);
  return r;
};
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.app.close();
});

const UNAUTH_BODY = { error: { code: "unauthorized", message_tr: "Yetkisiz." } };

describe("imza vektörleri HTTP üzerinden (signing-vectors.json v2)", () => {
  const keyOf = (id: string): string => vectors.keys.find((k: any) => k.id === id).spki_b64u;

  for (const v of vectors.envelope) {
    it(`${v.id}: ${v.expect_valid ? "geçerli imza kabul edilir" : "geçersiz imza 401 alır"} (${v.description})`, async () => {
      const r = mk();
      r.clock.t = v.input.ts_ms;
      const approval = genKey();
      const phone = new Phone("Vektör", { priv: undefined as any, pub: keyOf(v.key_id) }, approval);
      await pair(r, phone);
      const target = v.input.path + (v.input.raw_query ? "?" + v.input.raw_query : "");
      const body = Buffer.from(v.input.body_b64u, "base64url");
      const res = await rawHttp(r.app, {
        method: v.input.method,
        target,
        headers: { "x-vlad-device": phone.id, "x-vlad-ts": String(v.input.ts_ms), "x-vlad-nonce": v.input.nonce, "x-vlad-sig": v.signature_b64u, ...(body.length ? { "content-type": "application/json" } : {}) },
        ...(body.length ? { body: body.toString("utf8") } : {}),
      });
      if (v.expect_valid) expect(passedAuth(res.status, res.body), `${res.status} ${res.body}`).toBe(true);
      else {
        expect(res.status).toBe(401);
        expect(JSON.parse(res.body)).toEqual(UNAUTH_BODY);
      }
    });
  }

  it("vektördeki geçerli imza, başka bir cihazın (başka session anahtarlı) kimliğiyle sunulursa 401 alır", async () => {
    const r = mk();
    const v = vectors.envelope.find((e: any) => e.id === "env-get-empty-body");
    r.clock.t = v.input.ts_ms;
    const vecPhone = new Phone("Vektör", { priv: undefined as any, pub: vectors.keys.find((k: any) => k.id === v.key_id).spki_b64u }, genKey());
    await pair(r, vecPhone);
    const other = await pair(r, new Phone("Öteki"));
    const res = await rawHttp(r.app, { method: "GET", target: "/v1/home", headers: { "x-vlad-device": other.id, "x-vlad-ts": String(v.input.ts_ms), "x-vlad-nonce": v.input.nonce, "x-vlad-sig": v.signature_b64u } });
    expect(res.status).toBe(401);
  });
});

describe("imza biçimi", () => {
  it("geçerli low-S DER imzalı istek kabul edilir (taban çizgisi)", async () => {
    const r = mk();
    const p = await pair(r);
    expect(passedAuth((await call(r, p, "GET", GOOD_TARGET)).statusCode)).toBe(true);
  });

  it("aynı mesaj için geçerli yüksek-S ikiz imza 401 alır", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await call(r, p, "GET", GOOD_TARGET, undefined, { sig: signHighS });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(UNAUTH_BODY);
  });

  it("ham r||s imza 401 alır", async () => {
    const r = mk();
    const p = await pair(r);
    expect((await call(r, p, "GET", GOOD_TARGET, undefined, { sig: signRawRS })).statusCode).toBe(401);
  });

  it("DER'e sondan bayt eklenmiş imza 401 alır", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await call(r, p, "GET", GOOD_TARGET, undefined, { sig: (k, m) => b64u(Buffer.concat([Buffer.from(signLowS(k, m), "base64url"), Buffer.from([0])])) });
    expect(res.statusCode).toBe(401);
  });

  it("DER kesik imza 401 alır", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await call(r, p, "GET", GOOD_TARGET, undefined, { sig: (k, m) => b64u(Buffer.from(signLowS(k, m), "base64url").subarray(0, 40)) });
    expect(res.statusCode).toBe(401);
  });

  it("session yerine approval anahtarıyla atılmış zarf imzası 401 alır", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await call(r, p, "GET", GOOD_TARGET, undefined, { key: p.approval.priv });
    expect(res.statusCode).toBe(401);
  });

  it("standart base64 (+ / ve dolgu) yazılmış imza 401 alır", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "GET", GOOD_TARGET);
    const std = Buffer.from(h["x-vlad-sig"], "base64url").toString("base64"); // dolgulu, +/ alfabesi
    const res = await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: { ...h, "x-vlad-sig": std + "=" } });
    expect(res.statusCode).toBe(401);
  });

  it("imza başlığı boş ya da base64url dışı karakter içeriyorsa 401/400 alır", async () => {
    const r = mk();
    const p = await pair(r);
    for (const sig of ["", "!!!!", "  ", "AAAA AAAA"]) {
      const res = await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: { ...p.headers(r.clock, "GET", GOOD_TARGET), "x-vlad-sig": sig } });
      expect([400, 401], `sig=${JSON.stringify(sig)}`).toContain(res.statusCode);
    }
  });
});

describe("başlıklar", () => {
  for (const missing of ["x-vlad-device", "x-vlad-ts", "x-vlad-nonce", "x-vlad-sig"]) {
    it(`${missing} eksikse istek imzasız sayılır (401, aynı gövde)`, async () => {
      const r = mk();
      const p = await pair(r);
      const h: Record<string, string> = { ...p.headers(r.clock, "GET", GOOD_TARGET) };
      delete h[missing];
      const res = await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTH_BODY);
    });
  }

  for (const name of ["x-vlad-device", "x-vlad-ts", "x-vlad-nonce", "x-vlad-sig"]) {
    it(`yinelenen ${name} başlığı (ikisi de aynı geçerli değer) reddedilir`, async () => {
      const r = mk();
      const p = await pair(r);
      const h = p.headers(r.clock, "GET", GOOD_TARGET) as Record<string, string | string[]>;
      h[name] = [h[name] as string, h[name] as string];
      const res = await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: h });
      expect([400, 401]).toContain(res.status);
    });

    it(`yinelenen ${name} başlığında geçerli değer ilk sırada olsa da kötü ikinci değerle reddedilir`, async () => {
      const r = mk();
      const p = await pair(r);
      const h = p.headers(r.clock, "GET", GOOD_TARGET) as Record<string, string | string[]>;
      h[name] = [h[name] as string, "AAAA"];
      const res = await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: h });
      expect([400, 401]).toContain(res.status);
    });
  }

  it("bilinmeyen cihaz kimliği ile bilinen cihazın kötü imzası aynı yanıtı verir (cihaz sayımı sızmaz)", async () => {
    const r = mk();
    const p = await pair(r);
    const known = await call(r, p, "GET", GOOD_TARGET, undefined, { sig: signHighS });
    const unknown = await call(r, p, "GET", GOOD_TARGET, undefined, { device: "no-such-device" });
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
  });

  it("cihaz kimliği başlığı büyük/küçük harf değiştirilince başka cihaz sayılmaz (401)", async () => {
    const r = mk();
    const p = await pair(r);
    const alt = p.id === p.id.toUpperCase() ? p.id.toLowerCase() : p.id.toUpperCase();
    if (alt === p.id) return; // kimlikte harf yok
    expect((await call(r, p, "GET", GOOD_TARGET, undefined, { device: alt })).statusCode).toBe(401);
  });
});

describe("nonce biçimi", () => {
  for (const len of [0, 1, 21, 23, 24, 43]) {
    it(`${len} karakterlik nonce (imza kendi nonce'u üzerinden geçerli olsa da) reddedilir`, async () => {
      const r = mk();
      const p = await pair(r);
      const nonce = Buffer.alloc(32, 7).toString("base64url").slice(0, len);
      const res = await call(r, p, "GET", GOOD_TARGET, undefined, { nonce });
      expect([400, 401]).toContain(res.statusCode);
    });
  }

  it("22 karakterlik ama base64url dışı karakter içeren nonce reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    for (const nonce of ["AAAAAAAAAAAAAAAAAAAA+/", "AAAAAAAAAAAAAAAAAAAA==", "AAAAAAAAAAAAAAAAAAA A!"]) {
      const res = await call(r, p, "GET", GOOD_TARGET, undefined, { nonce });
      expect([400, 401], nonce).toContain(res.statusCode);
    }
  });

  it("tam 22 karakterlik geçerli nonce kabul edilir (sınır sağlama)", async () => {
    const r = mk();
    const p = await pair(r);
    expect(passedAuth((await call(r, p, "GET", GOOD_TARGET, undefined, { nonce: newNonce() })).statusCode)).toBe(true);
  });
});

describe("zaman penceresi (±120 sn dahil kabul, ±121 sn red)", () => {
  for (const [delta, ok] of [[0, true], [119_000, true], [120_000, true], [-119_000, true], [-120_000, true], [121_000, false], [-121_000, false], [3_600_000, false], [-3_600_000, false]] as const) {
    it(`ts = sunucu saati ${delta >= 0 ? "+" : ""}${delta / 1000} sn → ${ok ? "kabul" : "401"}`, async () => {
      const r = mk();
      const p = await pair(r);
      const res = await call(r, p, "GET", GOOD_TARGET, undefined, { ts: r.clock.t + delta });
      if (ok) expect(passedAuth(res.statusCode), res.body).toBe(true);
      else expect(res.statusCode).toBe(401);
    });
  }

  it("sunucu saati ilerleyince eski zaman damgalı geçerli imza reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "GET", GOOD_TARGET);
    r.clock.t += 121_000;
    expect((await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: h })).statusCode).toBe(401);
  });

  for (const bad of ["abc", "", "-1", "1.5", "1e12", "0x10", "NaN", "Infinity", "99999999999999999999999999"]) {
    it(`X-Vlad-Ts "${bad}" biçimi reddedilir`, async () => {
      const r = mk();
      const p = await pair(r);
      const res = await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: { ...p.headers(r.clock, "GET", GOOD_TARGET), "x-vlad-ts": bad } });
      expect([400, 401]).toContain(res.statusCode);
    });
  }

  it("ts başlığına öndeki sıfır/artı eklenince (kanonik olmayan yazım) imza geçerli kalsa da reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    const base = p.headers(r.clock, "GET", GOOD_TARGET);
    for (const ts of [`0${r.clock.t}`, `+${r.clock.t}`, `${r.clock.t}.0`, ` ${r.clock.t}`]) {
      const res = await r.app.inject({ method: "GET", url: GOOD_TARGET, headers: { ...base, "x-vlad-ts": ts, "x-vlad-nonce": base["x-vlad-nonce"] } });
      expect([400, 401], ts).toContain(res.statusCode);
    }
  });
});

describe("gövde bağlama", () => {
  it("imzalı gövde ile gönderilen gövde farklıysa (hash uyuşmazlığı) 401", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "POST", "/v1/chat", '{"message":"a"}');
    const res = await r.app.inject({ method: "POST", url: "/v1/chat", headers: { ...h, "content-type": "application/json" }, payload: '{"message":"b"}' });
    expect(res.statusCode).toBe(401);
  });

  it("gövdesi imzalanmış ama gönderilmemiş POST (boş gövde) 401", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "POST", "/v1/chat", '{"message":"a"}');
    expect((await r.app.inject({ method: "POST", url: "/v1/chat", headers: { ...h, "content-type": "application/json" } })).statusCode).toBe(401);
  });

  it("gövde sonuna tek bayt (boşluk) eklenirse 401", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "POST", "/v1/chat", '{"message":"a"}');
    expect((await r.app.inject({ method: "POST", url: "/v1/chat", headers: { ...h, "content-type": "application/json" }, payload: '{"message":"a"} ' })).statusCode).toBe(401);
  });

  it("imza yalnız ham baytlara bağlıdır: aynı JSON'un farklı boşluklu yazımı farklı imza ister", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "POST", "/v1/chat", '{"a":1}');
    expect((await r.app.inject({ method: "POST", url: "/v1/chat", headers: { ...h, "content-type": "application/json" }, payload: '{ "a": 1 }' })).statusCode).toBe(401);
  });

  it("geçerli imzalı gövde, content-type başlığı değişse de aynı baytlarla kabul edilir (içerik türü zarfta yok)", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "POST", "/v1/chat", '{"message":"a"}');
    const res = await r.app.inject({ method: "POST", url: "/v1/chat", headers: { ...h, "content-type": "text/plain" }, payload: '{"message":"a"}' });
    expect(res.statusCode).not.toBe(401);
  });

  it("1 MB üstü gövde, imza geçerli olsa da kabul edilmez (2xx/501 yok)", async () => {
    const r = mk();
    const p = await pair(r);
    const big = "x".repeat(1024 * 1024 + 1);
    const res = await call(r, p, "POST", "/v1/chat", big);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).not.toBe(501);
    expect(res.statusCode).not.toBe(200);
  });

  it("tam 1 MB gövde sınırda kabul edilir (imzası geçerliyse 413/401 değil)", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await call(r, p, "POST", "/v1/chat", "x".repeat(1024 * 1024));
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).not.toBe(401);
  });

  it("gövdeli GET, gövde imzaya dahil edilmiş olsa bile reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "GET", GOOD_TARGET, "x");
    const res = await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: { ...h, "content-length": "1" }, body: "x" });
    expect(passedAuth(res.status)).toBe(false);
  });

  it("gövdeli GET (chunked, imza boş gövde için) reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    const h = p.headers(r.clock, "GET", GOOD_TARGET);
    const res = await rawHttp(r.app, { method: "GET", target: GOOD_TARGET, headers: { ...h, "transfer-encoding": "chunked" }, body: "x" });
    expect(passedAuth(res.status)).toBe(false);
  });
});

describe("istek hedefi ve yöntem", () => {
  it("absolute-form hedef (http://host/v1/home) mutlak yol imzasıyla reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await rawHttp(r.app, { method: "GET", target: "http://127.0.0.1" + GOOD_TARGET, headers: p.headers(r.clock, "GET", GOOD_TARGET) });
    expect(passedAuth(res.status)).toBe(false);
  });

  it("absolute-form hedef, mutlak URL dizesi imzalanmış olsa da reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    const abs = "http://127.0.0.1" + GOOD_TARGET;
    const res = await rawHttp(r.app, { method: "GET", target: abs, headers: p.headers(r.clock, "GET", abs) });
    expect(passedAuth(res.status)).toBe(false);
  });

  it("farklı konak içeren absolute-form hedef (http://evil/v1/home) reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await rawHttp(r.app, { method: "GET", target: "http://evil.example" + GOOD_TARGET, headers: p.headers(r.clock, "GET", GOOD_TARGET) });
    expect(passedAuth(res.status)).toBe(false);
  });

  it("GET için atılmış imza HEAD olarak gönderilince 401 alır ve gövde sızmaz", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await rawHttp(r.app, { method: "HEAD", target: GOOD_TARGET, headers: p.headers(r.clock, "GET", GOOD_TARGET) });
    expect(res.status).toBe(401);
    expect(res.body).toBe("");
  });

  it("HEAD için doğru imzalansa da korumalı veri dönmez (2xx ve 501 yok, gövde boş)", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await rawHttp(r.app, { method: "HEAD", target: GOOD_TARGET, headers: p.headers(r.clock, "HEAD", GOOD_TARGET) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(501);
    expect(res.body).toBe("");
  });

  it("imzasız OPTIONS 401 alır ve CORS/Allow başlığı ile uç keşfi sızdırmaz", async () => {
    const r = mk();
    const res = await rawHttp(r.app, { method: "OPTIONS", target: GOOD_TARGET });
    expect(res.status).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["allow"]).toBeUndefined();
  });

  it("doğru imzalı OPTIONS korumalı bir işleyiciye ulaşmaz (2xx ve 501 yok)", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await rawHttp(r.app, { method: "OPTIONS", target: GOOD_TARGET, headers: p.headers(r.clock, "OPTIONS", GOOD_TARGET) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(501);
  });

  it("X-HTTP-Method-Override başlığı yöntemi değiştirmez (POST /grants/x → DELETE işleyicisine düşmez)", async () => {
    const r = mk();
    const p = await pair(r);
    const target = "/v1/grants/G-001";
    const base = await call(r, p, "POST", target, "{}");
    for (const hdr of ["x-http-method-override", "x-http-method", "x-method-override"]) {
      const h = p.headers(r.clock, "POST", target, "{}");
      const res = await r.app.inject({ method: "POST", url: target, headers: { ...h, [hdr]: "DELETE", "content-type": "application/json" }, payload: "{}" });
      expect(res.statusCode, hdr).toBe(base.statusCode);
      expect(res.body, hdr).toBe(base.body);
    }
  });

  it("imzalı sorguda _method=DELETE yöntemi değiştirmez (imzalı olsa bile)", async () => {
    const r = mk();
    const p = await pair(r);
    const plain = await call(r, p, "POST", "/v1/grants/G-001", "{}");
    const q = await call(r, p, "POST", "/v1/grants/G-001?_method=DELETE", "{}");
    expect(q.statusCode).toBe(plain.statusCode);
  });

  it("sorguda yinelenen anahtar (a=1&a=2 ve a ile %61) reddedilir", async () => {
    const r = mk();
    const p = await pair(r);
    for (const q of ["a=1&a=2", "a=1&%61=2", "a&a"]) {
      const h = p.headers(r.clock, "GET", "/v1/projects");
      const res = await r.app.inject({ method: "GET", url: "/v1/projects?" + q, headers: h });
      expect([400, 401], q).toContain(res.statusCode);
    }
  });

  it("sorgu sırası imzayı bozmaz ama değer değişirse 401 (sıralı kanonik sorgu imzalanır)", async () => {
    const r = mk();
    const p = await pair(r);
    const sorted = p.headers(r.clock, "GET", "/v1/projects?a=1&b=2");
    const ok = await r.app.inject({ method: "GET", url: "/v1/projects?b=2&a=1", headers: sorted });
    expect(passedAuth(ok.statusCode), ok.body).toBe(true);
    const sorted2 = p.headers(r.clock, "GET", "/v1/projects?a=1&b=2");
    const bad = await r.app.inject({ method: "GET", url: "/v1/projects?a=1&b=3", headers: sorted2 });
    expect(bad.statusCode).toBe(401);
  });

  it("sorgusuz imzalanmış istek sorgu eklenerek (/v1/home?x=1) 401 alır", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await r.app.inject({ method: "GET", url: "/v1/home?x=1", headers: p.headers(r.clock, "GET", "/v1/home") });
    expect(res.statusCode).toBe(401);
  });

  it("ham yol yüzde-kodlu eşdeğeriyle değiştirilirse (/v1/%68ome) imza geçersizdir", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await r.app.inject({ method: "GET", url: "/v1/%68ome", headers: p.headers(r.clock, "GET", "/v1/home") });
    expect(res.statusCode).toBe(401);
  });

  it("yol büyük/küçük harf değişimi (/v1/Home) imza geçersizdir", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await r.app.inject({ method: "GET", url: "/v1/Home", headers: p.headers(r.clock, "GET", "/v1/home") });
    expect(res.statusCode).toBe(401);
  });

  it("noktalı segment (/v1/x/../home) imzası /v1/home imzasıyla karıştırılamaz", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await rawHttp(r.app, { method: "GET", target: "/v1/x/../home", headers: p.headers(r.clock, "GET", "/v1/home") });
    expect(res.status).toBe(401);
  });

  it("imzasız 401 gövdesi bilgi sızdırmaz: yalnız {error:{code,message_tr}}, ek başlık/neden yok", async () => {
    const r = mk();
    const res = await r.app.inject({ method: "GET", url: GOOD_TARGET });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(UNAUTH_BODY);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("başarısız nedenlerin hepsi (imza, ts, nonce yok) aynı 401 gövdesini verir", async () => {
    const r = mk();
    const p = await pair(r);
    const bodies = new Set<string>();
    bodies.add((await call(r, p, "GET", GOOD_TARGET, undefined, { sig: signHighS })).body);
    bodies.add((await call(r, p, "GET", GOOD_TARGET, undefined, { ts: r.clock.t + 999_000 })).body);
    bodies.add((await call(r, p, "GET", GOOD_TARGET, undefined, { device: "ghost" })).body);
    bodies.add((await r.app.inject({ method: "GET", url: GOOD_TARGET })).body);
    expect(bodies.size).toBe(1);
  });
});
