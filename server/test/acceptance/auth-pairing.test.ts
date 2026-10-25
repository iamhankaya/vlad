// T6 kabul: eşleştirme (kod yanması, süre, tek kullanım, eşzamanlılık, anahtar doğrulama).
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GOOD_TARGET, Phone, b64u, call, genKey, issueCode, pair, pairBody, passedAuth, postPair, rig, type Rig } from "./auth-kit.ts";

const rigs: Rig[] = [];
const mk = (over: Parameters<typeof rig>[0] = {}) => {
  const r = rig({ limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] }, ...over });
  rigs.push(r);
  return r;
};
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.app.close();
});

const spki = (curve: string, type: "ec" | "ed25519" | "rsa" = "ec") => {
  const { publicKey } =
    type === "ec" ? generateKeyPairSync("ec", { namedCurve: curve }) : type === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("rsa", { modulusLength: 2048 });
  return b64u(publicKey.export({ format: "der", type: "spki" }));
};
const wrong = (code: string) => (code[0] === "0" ? "1" : "0") + code.slice(1);
const UNAUTH = { error: { code: "unauthorized", message_tr: "Yetkisiz." } };

describe("eşleştirme kodu", () => {
  it("doğru kod cihaz kaydı verir ve cihaz hemen imzalı istek atabilir", async () => {
    const r = mk();
    const p = await pair(r);
    expect(p.id).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(passedAuth((await call(r, p, "GET", GOOD_TARGET)).statusCode)).toBe(true);
  });

  it("kod büyük/küçük harf fark etmez (sunucu normalize eder)", async () => {
    const r = mk();
    const p = new Phone();
    const res = await postPair(r, pairBody(issueCode(r).toLowerCase(), p));
    expect(res.statusCode).toBe(200);
  });

  it("5 yanlış denemeden sonra doğru kod da 401 alır (kod yanar)", async () => {
    const r = mk();
    const code = issueCode(r);
    for (let i = 0; i < 5; i++) expect((await postPair(r, pairBody(wrong(code), new Phone()))).statusCode).toBe(401);
    const res = await postPair(r, pairBody(code, new Phone()));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(UNAUTH);
  });

  it("4 yanlış denemeden sonra doğru kod hâlâ kabul edilir (yanma sınırı tam 5)", async () => {
    const r = mk();
    const code = issueCode(r);
    for (let i = 0; i < 4; i++) await postPair(r, pairBody(wrong(code), new Phone()));
    expect((await postPair(r, pairBody(code, new Phone()))).statusCode).toBe(200);
  });

  it("yanma sayacı genel: yanlışlar farklı biçimlerde (başka sahte kodlar) olsa da 5'te kod yanar", async () => {
    const r = mk();
    const code = issueCode(r);
    const guesses = ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC", "DDDDDDDD", "EEEEEEEE"].filter((g) => g !== code.toUpperCase());
    for (const g of guesses) await postPair(r, pairBody(g, new Phone()));
    expect((await postPair(r, pairBody(code, new Phone()))).statusCode).toBe(401);
  });

  it("kod yanması yeniden başlatmada da sürer", async () => {
    const r = mk();
    const code = issueCode(r);
    for (let i = 0; i < 5; i++) await postPair(r, pairBody(wrong(code), new Phone()));
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    expect((await postPair(r2, pairBody(code, new Phone()))).statusCode).toBe(401);
  });

  it("kod tek kullanımlıktır: ikinci cihaz aynı kodla 401 alır", async () => {
    const r = mk();
    const code = issueCode(r);
    expect((await postPair(r, pairBody(code, new Phone("A")))).statusCode).toBe(200);
    expect((await postPair(r, pairBody(code, new Phone("B")))).statusCode).toBe(401);
  });

  it("tek kullanım yeniden başlatmada da sürer", async () => {
    const r = mk();
    const code = issueCode(r);
    await postPair(r, pairBody(code, new Phone("A")));
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    expect((await postPair(r2, pairBody(code, new Phone("B")))).statusCode).toBe(401);
  });

  it("kod 10 dk içinde geçerlidir (9 dk 59 sn)", async () => {
    const r = mk();
    const code = issueCode(r);
    r.clock.t += 10 * 60_000 - 1_000;
    expect((await postPair(r, pairBody(code, new Phone()))).statusCode).toBe(200);
  });

  it("kod 10 dk sonra geçersizdir (10 dk 1 sn)", async () => {
    const r = mk();
    const code = issueCode(r);
    r.clock.t += 10 * 60_000 + 1_000;
    const res = await postPair(r, pairBody(code, new Phone()));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(UNAUTH);
  });

  it("süresi dolmuş kod yeniden başlatma sonrası da geçersizdir", async () => {
    const r = mk();
    const code = issueCode(r);
    r.clock.t += 11 * 60_000;
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    expect((await postPair(r2, pairBody(code, new Phone()))).statusCode).toBe(401);
  });

  it("hiç kod üretilmemişken rastgele kod 401 alır", async () => {
    const r = mk();
    expect((await postPair(r, pairBody("ABCDEFGH", new Phone()))).statusCode).toBe(401);
  });

  it("yanlış, yanmış, süresi dolmuş, kullanılmış kod aynı 401 gövdesini verir (neden sızmaz)", async () => {
    const r = mk();
    const bodies = new Set<string>();
    const c1 = issueCode(r);
    bodies.add((await postPair(r, pairBody(wrong(c1), new Phone()))).body);
    await postPair(r, pairBody(c1, new Phone()));
    bodies.add((await postPair(r, pairBody(c1, new Phone()))).body);
    const c2 = issueCode(r);
    r.clock.t += 11 * 60_000;
    bodies.add((await postPair(r, pairBody(c2, new Phone()))).body);
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0]!)).toEqual(UNAUTH);
  });

  it("eşzamanlı iki doğru kod isteğinden yalnız biri cihaz kaydeder", async () => {
    const r = mk();
    const code = issueCode(r);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => postPair(r, pairBody(code, new Phone(`Tel ${i}`)))));
    expect(results.filter((x) => x.statusCode === 200)).toHaveLength(1);
    expect(results.filter((x) => x.statusCode === 401)).toHaveLength(5);
  });

  it("kod biçimi bozuksa (7/9 karakter, boşluk, boş) 400 alır", async () => {
    const r = mk();
    for (const code of ["ABCDEFG", "ABCDEFGHI", "ABCD EFG", "", "ABCDEFG!"]) {
      expect((await postPair(r, pairBody(code, new Phone()))).statusCode, JSON.stringify(code)).toBe(400);
    }
  });

  it("kod JSON'da string değilse (sayı, dizi, null) 400 alır", async () => {
    const r = mk();
    const p = new Phone();
    for (const code of [12345678, ["ABCDEFGH"], null, { x: 1 }]) {
      const res = await postPair(r, JSON.stringify({ code, device_name: "x", session_pub: p.session.pub, approval_pub: p.approval.pub }));
      expect(res.statusCode, JSON.stringify(code)).toBe(400);
    }
  });
});

describe("anahtar doğrulama", () => {
  it("session anahtarı P-384 ise 400 alır ve cihaz kaydedilmez", async () => {
    const r = mk();
    const p = new Phone("x", { priv: genKey().priv, pub: spki("secp384r1") }, genKey());
    const res = await postPair(r, pairBody(issueCode(r), p));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("approval anahtarı P-384 ise 400 alır", async () => {
    const r = mk();
    const p = new Phone("x", genKey(), { priv: genKey().priv, pub: spki("secp384r1") });
    expect((await postPair(r, pairBody(issueCode(r), p))).statusCode).toBe(400);
  });

  it("secp256k1, Ed25519 ve RSA SPKI'ları 400 alır", async () => {
    const r = mk();
    for (const bad of [spki("secp256k1"), spki("", "ed25519"), spki("", "rsa")]) {
      const p = new Phone("x", { priv: genKey().priv, pub: bad }, genKey());
      expect((await postPair(r, pairBody(issueCode(r), p))).statusCode).toBe(400);
      const q = new Phone("x", genKey(), { priv: genKey().priv, pub: bad });
      expect((await postPair(r, pairBody(issueCode(r), q))).statusCode).toBe(400);
    }
  });

  it("bozuk SPKI (kesik, sonuna bayt eklenmiş, rastgele, başlık bozuk) 400 alır", async () => {
    const r = mk();
    const good = genKey().pub;
    const buf = Buffer.from(good, "base64url");
    const mutated = Buffer.from(buf);
    mutated[10] ^= 0xff;
    const cases = [good.slice(0, 100), b64u(Buffer.concat([buf, Buffer.from([0])])), b64u(Buffer.alloc(91, 1)), b64u(mutated), "A".repeat(122), "!".repeat(122), ""];
    for (const bad of cases) {
      const p = new Phone("x", { priv: genKey().priv, pub: bad }, genKey());
      expect((await postPair(r, pairBody(issueCode(r), p))).statusCode, bad.slice(0, 12)).toBe(400);
    }
  });

  it("noktası eğri üzerinde olmayan P-256 SPKI 400 alır", async () => {
    const r = mk();
    const buf = Buffer.from(genKey().pub, "base64url");
    buf[buf.length - 1] ^= 0x01; // Y koordinatını bozar
    const p = new Phone("x", { priv: genKey().priv, pub: b64u(buf) }, genKey());
    expect((await postPair(r, pairBody(issueCode(r), p))).statusCode).toBe(400);
  });

  it("aynı anahtar hem session hem approval olarak gönderilirse 400", async () => {
    const r = mk();
    const k = genKey();
    expect((await postPair(r, pairBody(issueCode(r), new Phone("x", k, k)))).statusCode).toBe(400);
  });

  it("birinci cihazın session anahtarı ikinci cihazda session olarak yeniden kullanılırsa 400", async () => {
    const r = mk();
    const a = await pair(r);
    expect((await postPair(r, pairBody(issueCode(r), new Phone("B", a.session, genKey())))).statusCode).toBe(400);
  });

  it("birinci cihazın approval anahtarı ikinci cihazda approval olarak yeniden kullanılırsa 400", async () => {
    const r = mk();
    const a = await pair(r);
    expect((await postPair(r, pairBody(issueCode(r), new Phone("B", genKey(), a.approval)))).statusCode).toBe(400);
  });

  it("birinci cihazın session anahtarı ikinci cihazda approval olarak kullanılırsa 400 (rol çaprazlama)", async () => {
    const r = mk();
    const a = await pair(r);
    expect((await postPair(r, pairBody(issueCode(r), new Phone("B", genKey(), a.session)))).statusCode).toBe(400);
  });

  it("birinci cihazın approval anahtarı ikinci cihazda session olarak kullanılırsa 400 (rol çaprazlama)", async () => {
    const r = mk();
    const a = await pair(r);
    expect((await postPair(r, pairBody(issueCode(r), new Phone("B", a.approval, genKey())))).statusCode).toBe(400);
  });

  it("anahtar yeniden kullanımı yeniden başlatma sonrası da reddedilir", async () => {
    const r = mk();
    const a = await pair(r);
    await r.app.close();
    const r2 = r.restart();
    rigs.push(r2);
    expect((await postPair(r2, pairBody(issueCode(r2), new Phone("B", a.session, genKey())))).statusCode).toBe(400);
  });

  it("iki ayrı cihaz kendi anahtarlarıyla eşleşir ve birinin imzası ötekinin kimliğiyle geçmez", async () => {
    const r = mk();
    const a = await pair(r, new Phone("A"));
    const b = await pair(r, new Phone("B"));
    expect(a.id).not.toBe(b.id);
    expect(passedAuth((await call(r, a, "GET", GOOD_TARGET)).statusCode)).toBe(true);
    expect(passedAuth((await call(r, b, "GET", GOOD_TARGET)).statusCode)).toBe(true);
    expect((await call(r, a, "GET", GOOD_TARGET, undefined, { device: b.id })).statusCode).toBe(401);
  });

  it("geçersiz anahtarla yapılan eşleştirme denemesi kodu 2 denemede yakmaz (kod sonradan geçerli anahtarla kullanılabilir)", async () => {
    const r = mk();
    const code = issueCode(r);
    const bad = new Phone("x", { priv: genKey().priv, pub: spki("secp384r1") }, genKey());
    for (let i = 0; i < 2; i++) await postPair(r, pairBody(code, bad));
    expect((await postPair(r, pairBody(code, new Phone()))).statusCode).toBe(200);
  });
});

describe("alan doğrulama", () => {
  const withBase = (r: Rig, extra: Record<string, unknown>, drop: string[] = []) => {
    const p = new Phone();
    const body: Record<string, unknown> = { code: issueCode(r), device_name: "Pixel", session_pub: p.session.pub, approval_pub: p.approval.pub, ...extra };
    for (const d of drop) delete body[d];
    return postPair(r, JSON.stringify(body));
  };

  it("device_name boş, 65 karakter ya da denetim karakteri içeriyorsa 400", async () => {
    const r = mk();
    for (const device_name of ["", "x".repeat(65), "a\nb", "a\u0000b", "a\u007fb", "a\rb"]) {
      expect((await withBase(r, { device_name })).statusCode, JSON.stringify(device_name)).toBe(400);
    }
  });

  it("device_name 64 karakter sınırda kabul edilir", async () => {
    const r = mk();
    expect((await withBase(r, { device_name: "x".repeat(64) })).statusCode).toBe(200);
  });

  it("device_name string değilse 400", async () => {
    const r = mk();
    for (const device_name of [1, null, ["a"], {}]) expect((await withBase(r, { device_name })).statusCode).toBe(400);
  });

  it("fcm_token boş, 4097 karakter ya da string değilse 400; 4096 sınırda kabul", async () => {
    const r = mk();
    for (const fcm_token of ["", "x".repeat(4097), 5, null]) expect((await withBase(r, { fcm_token })).statusCode, String(fcm_token).slice(0, 8)).toBe(400);
    expect((await withBase(r, { fcm_token: "x".repeat(4096) })).statusCode).toBe(200);
  });

  it("bilinmeyen ek alan (additionalProperties:false) 400", async () => {
    const r = mk();
    expect((await withBase(r, { role: "admin" })).statusCode).toBe(400);
    expect((await withBase(r, { device_id: "chosen-id" })).statusCode).toBe(400);
  });

  it("zorunlu alanlardan biri eksikse 400", async () => {
    const r = mk();
    for (const k of ["code", "device_name", "session_pub", "approval_pub"]) expect((await withBase(r, {}, [k])).statusCode, k).toBe(400);
  });

  it("gövde JSON değilse ya da nesne değilse 400", async () => {
    const r = mk();
    for (const payload of ["not json", "[]", "null", '"x"', "{", ""]) expect((await postPair(r, payload)).statusCode, JSON.stringify(payload)).toBe(400);
  });

  it("geçersiz UTF-8 baytlı gövde 400 alır", async () => {
    const r = mk();
    const res = await r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) });
    expect(res.statusCode).toBe(400);
  });

  it("1 MB üstü eşleştirme gövdesi reddedilir", async () => {
    const r = mk();
    const res = await postPair(r, JSON.stringify({ code: "ABCDEFGH", device_name: "x".repeat(1024 * 1024 + 10) }));
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).not.toBe(200);
  });

  it("kayıtlı iki cihaza ayrı device_id atanır, istemci kimlik seçemez", async () => {
    const r = mk();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await pair(r, new Phone("Pixel 9"))).id);
    expect(ids.size).toBe(5);
  });
});
