// T6 kabul: rota envanteri. openapi.yaml'daki her uç için imzasız istek aynı 401 gövdesini alır; bilinmeyen yol da 401.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CONTRACT, Phone, call, pair, passedAuth, rawHttp, rig, type Rig } from "./auth-kit.ts";

const doc: any = parse(readFileSync(join(CONTRACT, "openapi.yaml"), "utf8"));
const METHODS = ["get", "post", "put", "delete", "patch"];
const ops = Object.entries<any>(doc.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({ id: item[m].operationId as string, method: m.toUpperCase(), path: "/v1" + (path as string), auth: item[m]["x-vlad-auth"] as string })),
);
const SAMPLE: Record<string, string> = { id: "x", slug: "vlad" };
const concrete = (p: string, id?: string) => p.replace(/\{(\w+)\}/g, (_, n) => (n === "id" && id ? id : (SAMPLE[n] ?? "x")));

const rigs: Rig[] = [];
const mk = () => {
  const r = rig({ limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] } });
  rigs.push(r);
  return r;
};
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.app.close();
});

const UNAUTH = { error: { code: "unauthorized", message_tr: "Yetkisiz." } };
const protectedOps = ops.filter((o) => o.auth !== "none");

describe("openapi envanteri", () => {
  it("openapi'de en az 25 uç var ve hepsinin x-vlad-auth değeri none|session|session+approval", () => {
    expect(ops.length).toBeGreaterThanOrEqual(25);
    for (const o of ops) expect(["none", "session", "session+approval"], o.id).toContain(o.auth);
  });

  it("imzasız uçlar yalnız getHealth ve pairDevice", () => {
    expect(ops.filter((o) => o.auth === "none").map((o) => o.id).sort()).toEqual(["getHealth", "pairDevice"]);
  });

  for (const o of protectedOps) {
    it(`${o.method} ${o.path} (${o.id}, ${o.auth}) imzasız → 401, gövde standart ve neden sızdırmaz`, async () => {
      const r = mk();
      const hasBody = o.method !== "GET" && o.method !== "DELETE";
      const res = await r.app.inject({
        method: o.method as "GET",
        url: concrete(o.path),
        ...(hasBody ? { headers: { "content-type": "application/json" }, payload: "{}" } : {}),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTH);
    });

    it(`${o.method} ${o.path} (${o.id}) bozuk imza başlıklarıyla → 401, imzasızla aynı gövde`, async () => {
      const r = mk();
      const hasBody = o.method !== "GET" && o.method !== "DELETE";
      const res = await r.app.inject({
        method: o.method as "GET",
        url: concrete(o.path),
        headers: { "x-vlad-device": "ghost", "x-vlad-ts": String(r.clock.t), "x-vlad-nonce": "AAAAAAAAAAAAAAAAAAAAAA", "x-vlad-sig": "AAAA", ...(hasBody ? { "content-type": "application/json" } : {}) },
        ...(hasBody ? { payload: "{}" } : {}),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTH);
    });

    it(`${o.method} ${o.path} (${o.id}) eşleşmiş cihazın doğru imzasıyla kimlik doğrulamasını geçer (401/429 değil)`, async () => {
      const r = mk();
      const p = await pair(r);
      const target = concrete(o.path, o.path.includes("/devices/") ? p.id : undefined);
      const hasBody = o.method !== "GET" && o.method !== "DELETE";
      const res = await call(r, p, o.method, target, hasBody ? "{}" : undefined);
      // Gövde "{}" olduğundan işleyici 400 (gövde doğrulaması) dönebilir; zarf reddi yalnız 401/429'dur (400 ayrıntısız auth hataları ayrı testlerde).
      expect([401, 429], `${res.statusCode} ${res.body}`).not.toContain(res.statusCode);
    });
  }

  it("imzasız tüm korumalı uçların 401 gövdeleri bayt bayt aynıdır", async () => {
    const r = mk();
    const bodies = new Set<string>();
    for (const o of protectedOps) {
      const hasBody = o.method !== "GET" && o.method !== "DELETE";
      const res = await r.app.inject({ method: o.method as "GET", url: concrete(o.path), ...(hasBody ? { headers: { "content-type": "application/json" }, payload: "{}" } : {}) });
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
  });

  it("imzasız POST'ta bozuk JSON gövde 400 değil 401 verir (imzadan önce ayrıştırma yok)", async () => {
    const r = mk();
    for (const o of protectedOps.filter((x) => x.method === "POST")) {
      const res = await r.app.inject({ method: "POST", url: concrete(o.path), headers: { "content-type": "application/json" }, payload: "{not json" });
      expect(res.statusCode, o.id).toBe(401);
    }
  });

  it("imzasız istekte tanınmayan content-type 415 değil 401 verir", async () => {
    const r = mk();
    for (const ct of ["application/xml", "text/plain", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded"]) {
      const res = await r.app.inject({ method: "POST", url: "/v1/chat", headers: { "content-type": ct }, payload: "x" });
      expect(res.statusCode, ct).toBe(401);
    }
  });
});

describe("bilinmeyen yollar", () => {
  const unknown = ["/", "/v1", "/v1/", "/v2/home", "/admin", "/v1/unknown", "/v1/home/extra", "/v1/health/x", "/.env", "/v1/../etc/passwd", "/v1/%00", "/v1/devices/", "/metrics", "/v1/pair/x"];
  for (const path of unknown) {
    it(`imzasız GET ${path} → 401 aynı gövde`, async () => {
      const r = mk();
      const res = await rawHttp(r.app, { method: "GET", target: path });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual(UNAUTH);
    });
  }

  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    it(`imzasız ${method} bilinmeyen yola → 401`, async () => {
      const r = mk();
      const res = await rawHttp(r.app, { method, target: "/v1/nothing-here", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual(UNAUTH);
    });
  }

  it("açık uçların biçim varyantları imzasız geçmez: /v1/health/ , //v1/health, /v1/%68ealth , /v1/Health , /v1/health?x=1 dışındakiler 401", async () => {
    const r = mk();
    for (const path of ["/v1/health/", "//v1/health", "/v1/%68ealth", "/v1/Health", "/v1/health%2F", "/v1/./health", "/v1/health;x"]) {
      const res = await rawHttp(r.app, { method: "GET", target: path });
      expect(res.status, path).toBe(401);
    }
  });

  it("açık uçlara yanlış yöntemle imzasız istek 200 vermez (POST /health, GET /pair, DELETE /pair)", async () => {
    const r = mk();
    for (const [method, path] of [["POST", "/v1/health"], ["GET", "/v1/pair"], ["DELETE", "/v1/pair"], ["PUT", "/v1/health"], ["POST", "/v1/pair/"]]) {
      const hasBody = method !== "GET";
      const res = await rawHttp(r.app, { method, target: path, ...(hasBody ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("imzalı geçerli istek bilinmeyen yola yalnız 404 verir; veri sızmaz", async () => {
    const r = mk();
    const p = await pair(r);
    const res = await call(r, p, "GET", "/v1/definitely-not-a-route");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("GET /v1/health imzasız 200, sürümden başka bir şey sızdırmaz", async () => {
    const r = mk();
    const res = await r.app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(["ok", "version"]);
  });

  it("imzalı geçerli istek, kimlik doğrulama başarılıyken de bilinmeyen yolda route listesi/ipucu vermez", async () => {
    const r = mk();
    const p = await pair(r, new Phone());
    const res = await call(r, p, "GET", "/v1/definitely-not-a-route");
    expect(passedAuth(res.statusCode)).toBe(true);
    expect(res.body).not.toMatch(/\/v1\/(home|cards|grants)/);
  });
});
