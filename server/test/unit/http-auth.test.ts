import { readFileSync, readdirSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../../src/http/routes.generated.ts";
import { doc, operations } from "../helpers/openapi.ts";
import { pairDevice, rig, signedCall, TestDevice } from "../helpers/client.ts";
import { generate } from "../../scripts/gen-routes.ts";
import { CONTRACT_DIR } from "../helpers/contract.ts";

const err = (res: { json: () => any }) => res.json().error;

describe("route inventory", () => {
  it("routes.generated.ts is current with contract/openapi.yaml", () => {
    const next = generate(readFileSync(join(CONTRACT_DIR, "openapi.yaml"), "utf8"));
    expect(readFileSync(new URL("../../src/http/routes.generated.ts", import.meta.url), "utf8")).toBe(next);
  });
  it("covers every openapi operation with its x-vlad-auth", () => {
    expect(ROUTES.map((r) => r.operationId).sort()).toEqual(operations.map((o) => o.id).sort());
    for (const o of operations) expect(ROUTES.find((r) => r.operationId === o.id)!.auth).toBe(o.op["x-vlad-auth"]);
    expect(doc.servers[0].url).toBe("/v1");
  });
});

describe("unsigned access", () => {
  it("only /v1/health and /v1/pair are reachable without a signature; everything else is 401 with the same body", async () => {
    const r = rig({ limits: { unpaired: [1000, 1000] } });
    const bodies = new Set<string>();
    for (const route of ROUTES.filter((x) => x.auth !== "none")) {
      const url = route.path.replace(/:(\w+)/g, "x1");
      const res = await r.app.inject({ method: route.method as "GET", url, ...(route.method !== "GET" ? { payload: "{}", headers: { "content-type": "application/json" } } : {}) });
      expect(res.statusCode, `${route.method} ${url}`).toBe(401);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
    expect((await r.app.inject({ method: "GET", url: "/v1/health" })).statusCode).toBe(200);
  });

  it("unknown paths, wrong methods, trailing slash and encoded health are 401, not 404", async () => {
    const r = rig();
    for (const [m, u] of [["GET", "/nope"], ["DELETE", "/v1/findings"], ["GET", "/v1/health/"], ["GET", "//v1/health"], ["POST", "/v1/pair/"], ["HEAD", "/v1/health"], ["GET", "/v1/%68ealth"]] as const) {
      const res = await r.app.inject({ method: m, url: u });
      expect(res.statusCode, `${m} ${u}`).toBe(401);
    }
  });

  it("garbage in each header is 401 and never crashes", async () => {
    const r = rig({ limits: { unpaired: [1000, 1000] } });
    const d = await pairDevice(r);
    const good = d.headers(r.clock, "GET", "/v1/chat/history");
    for (const k of Object.keys(good) as (keyof typeof good)[]) {
      for (const bad of ["", "x", "é", "0".repeat(200), "a, b"]) {
        const res = await r.app.inject({ method: "GET", url: "/v1/chat/history", headers: { ...good, [k]: bad } });
        expect(res.statusCode, `${k}=${bad}`).toBe(401);
      }
      const { [k]: _omit, ...rest } = good;
      expect((await r.app.inject({ method: "GET", url: "/v1/chat/history", headers: rest })).statusCode).toBe(401);
    }
  });

  it("an absolute-form request target (only possible on a real socket) is rejected", async () => {
    const r = rig();
    await r.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const port = (r.app.server.address() as { port: number }).port;
      const status = await new Promise<number>((resolve, reject) => {
        const s = connect(port, "127.0.0.1", () => s.write("GET http://evil.example/v1/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
        let buf = "";
        s.on("data", (c) => (buf += c));
        s.on("end", () => resolve(Number(buf.split(" ")[1])));
        s.on("error", reject);
      });
      expect(status).toBe(400);
    } finally {
      await r.app.close();
    }
  });
});

describe("pairing over HTTP", () => {
  it("pairs with a valid code once; the code cannot be reused", async () => {
    const r = rig();
    const d = new TestDevice();
    const { code } = r.codes.issue();
    const payload = JSON.stringify({ code, device_name: "Pixel 9", session_pub: d.session.pub, approval_pub: d.approval.pub, fcm_token: "t" });
    const ok = await r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ device_id: "d-pixel-9", server_time: r.clock.t });
    const d2 = new TestDevice();
    const again = await r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload: JSON.stringify({ code, device_name: "Pixel 9", session_pub: d2.session.pub, approval_pub: d2.approval.pub }) });
    expect(again.statusCode).toBe(401);
    expect(err(again).code).toBe("unauthorized");
  });

  it("wrong code is 401 with an opaque body; 5 wrong attempts burn the real code", async () => {
    const r = rig({ limits: { unpaired: [100, 100] } });
    const { code } = r.codes.issue();
    const d = new TestDevice();
    const go = (c: string) =>
      r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload: JSON.stringify({ code: c, device_name: "P", session_pub: d.session.pub, approval_pub: d.approval.pub }) });
    for (let i = 0; i < 5; i++) expect((await go("AAAAAAAA")).statusCode).toBe(401);
    expect((await go(code)).statusCode).toBe(401);
  });

  it("rejects non-P-256, malformed keys and one key used for both roles with 400 without burning the code", async () => {
    const r = rig();
    const { code } = r.codes.issue();
    const d = new TestDevice();
    const { generateKeyPairSync } = await import("node:crypto");
    const rsa = Buffer.from(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" })).toString("base64url");
    const p384 = Buffer.from(generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ format: "der", type: "spki" })).toString("base64url");
    const go = (b: object) => r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload: JSON.stringify({ code, device_name: "P", ...b }) });
    for (const bad of [
      { session_pub: rsa, approval_pub: d.approval.pub },
      { session_pub: p384, approval_pub: d.approval.pub },
      { session_pub: "A".repeat(122), approval_pub: d.approval.pub },
      { session_pub: d.session.pub, approval_pub: d.session.pub },
      { session_pub: d.session.pub, approval_pub: d.approval.pub, extra: 1 },
    ]) expect((await go(bad)).statusCode).toBe(400);
    expect((await go({ session_pub: d.session.pub, approval_pub: d.approval.pub })).statusCode).toBe(200);
  });

  it("a key that is already registered cannot be registered again", async () => {
    const r = rig();
    const d = await pairDevice(r);
    const { code } = r.codes.issue();
    const res = await r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload: JSON.stringify({ code, device_name: "Clone", session_pub: d.session.pub, approval_pub: new TestDevice().approval.pub }) });
    expect(res.statusCode).toBe(400);
  });

  it("malformed JSON and non-object bodies are 400", async () => {
    const r = rig();
    for (const payload of ["{", "[]", "null", "\"x\"", ""]) {
      const res = await r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload });
      expect(res.statusCode, payload).toBe(400);
    }
  });

  it("unpaired bucket: pairing attempts are rate limited with retry_after_s", async () => {
    const r = rig({ limits: { unpaired: [3, 0.01] } });
    const send = () => r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload: "{}" });
    expect([(await send()).statusCode, (await send()).statusCode, (await send()).statusCode]).toEqual([400, 400, 400]);
    const res = await send();
    expect(res.statusCode).toBe(429);
    expect(err(res).code).toBe("rate_limited");
    expect(err(res).details.retry_after_s).toBeGreaterThanOrEqual(1);
  });

  it("state files are 0600 and the directory 0700", async () => {
    const r = rig();
    await pairDevice(r);
    expect(statSync(r.dir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(r.dir)) if (!statSync(join(r.dir, f)).isDirectory()) expect(statSync(join(r.dir, f)).mode & 0o777, f).toBe(0o600);
    expect(readFileSync(join(r.dir, "devices.json"), "utf8")).toContain("d-pixel-9");
  });
});

// implemented by S6c (read-routes.test.ts) and S6d (events.test.ts); the rest still answer 501
const READ_OPS = ["getHome", "getCard", "getTask", "listPipelines", "listProjects", "getProject", "listFindings", "searchVault", "readVaultFile", "listEvents", "streamEvents"];

describe("signed requests", () => {
  it("a paired device passes the preHandler; unimplemented routes answer 501, never data", async () => {
    const r = rig();
    const d = await pairDevice(r);
    for (const route of ROUTES.filter((x) => x.auth !== "none" && x.operationId !== "revokeDevice" && !READ_OPS.includes(x.operationId))) {
      const url = route.path.replace(/:(\w+)/g, "x1");
      const res = await signedCall(r, d, route.method, url, route.method === "GET" ? undefined : "{}");
      expect(res.statusCode, `${route.method} ${url}`).toBe(501);
      expect(err(res).details.reason).toBe("not_implemented");
    }
    const unknown = await signedCall(r, d, "GET", "/v1/nope");
    expect(unknown.statusCode).toBe(404);
  });

  it("the window is +-120 s inclusive; +-121 s is rejected", async () => {
    const r = rig();
    const d = await pairDevice(r);
    const at = (dt: number) => signedCall(r, d, "GET", "/v1/chat/history", undefined, { ts: r.clock.t + dt });
    expect((await at(120_000)).statusCode).toBe(501);
    expect((await at(-120_000)).statusCode).toBe(501);
    expect((await at(121_000)).statusCode).toBe(401);
    expect((await at(-121_000)).statusCode).toBe(401);
  });

  it("a nonce is single use, also after a restart, and is forgotten after 5 minutes", async () => {
    let r = rig();
    const d = await pairDevice(r);
    const nonce = "AAAAAAAAAAAAAAAAAAAAAA";
    const t0 = r.clock.t;
    expect((await signedCall(r, d, "GET", "/v1/chat/history", undefined, { nonce })).statusCode).toBe(501);
    expect((await signedCall(r, d, "GET", "/v1/chat/history", undefined, { nonce })).statusCode).toBe(401);
    r = r.restart();
    expect((await signedCall(r, d, "GET", "/v1/chat/history", undefined, { nonce })).statusCode).toBe(401);
    r.clock.t = t0 + 5 * 60_000 + 1;
    // same nonce much later: outside the replay TTL, but only reachable with a fresh ts
    expect((await signedCall(r, d, "GET", "/v1/chat/history", undefined, { nonce })).statusCode).toBe(501);
  });

  it("an invalid signature does not store its nonce (cache cannot be filled with garbage)", async () => {
    const r = rig();
    const d = await pairDevice(r);
    const nonce = "BBBBBBBBBBBBBBBBBBBBBB";
    const bad = { ...d.headers(r.clock, "GET", "/v1/chat/history", "", { nonce }), "x-vlad-sig": "MEUCIQC" };
    expect((await r.app.inject({ method: "GET", url: "/v1/chat/history", headers: bad })).statusCode).toBe(401);
    expect((await signedCall(r, d, "GET", "/v1/chat/history", undefined, { nonce })).statusCode).toBe(501);
  });

  it("the signature binds method, raw target, query and body bytes", async () => {
    const r = rig();
    const d = await pairDevice(r);
    // a fresh nonce per attempt: reusing one is the replay path, not what this test is about
    const sign = (target: string, body: string, method = "POST") => d.headers(r.clock, method, target, body);
    expect((await r.app.inject({ method: "POST", url: "/v1/chat?a=1&b=2", headers: { ...sign("/v1/chat?b=2&a=1", '{"text":"a"}'), "content-type": "application/json" }, payload: '{"text":"a"}' })).statusCode).toBe(501); // query order is canonical
    expect((await r.app.inject({ method: "POST", url: "/v1/chat?a=1&b=3", headers: { ...sign("/v1/chat?b=2&a=1", '{"text":"a"}'), "content-type": "application/json" }, payload: '{"text":"a"}' })).statusCode).toBe(401);
    expect((await r.app.inject({ method: "POST", url: "/v1/chat", headers: { ...sign("/v1/chat", '{"text":"a"}'), "content-type": "application/json" }, payload: '{"text":"b"}' })).statusCode).toBe(401);
    expect((await r.app.inject({ method: "PUT", url: "/v1/chat", headers: { ...sign("/v1/chat", "{}"), "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(401);
  });

  it("raw path classes are distinct: %2F, //, trailing slash are not the signed path", async () => {
    const r = rig();
    const d = await pairDevice(r);
    const call = (signed: string, sent: string, method: "GET" | "DELETE" = "GET") => r.app.inject({ method, url: sent, headers: d.headers(r.clock, method, signed) });
    // a param route that is still unimplemented (no GET one is left): DELETE /v1/grants/{id}, S10; GET /v1/projects/{slug} has a handler since S12a
    expect((await call("/v1/grants/a", "/v1/grants/a", "DELETE")).statusCode).toBe(501);
    expect((await call("/v1/grants/a%2Fb", "/v1/grants/a%2Fb", "DELETE")).statusCode).toBe(501);
    expect((await call("/v1/grants/a", "/v1/grants/a%2Fb", "DELETE")).statusCode).toBe(401);
    expect((await call("/v1/chat/history", "/v1/chat/history/")).statusCode).toBe(401);
    expect((await call("/v1/chat/history/", "/v1/chat/history/")).statusCode).toBe(404); // signed trailing slash: authenticated, then no such route
    expect((await call("/v1/chat/history", "//v1/chat/history")).statusCode).toBe(401);
    expect((await call("/v1/grants/a", "/v1/%67rants/a", "DELETE")).statusCode).toBe(401);
  });

  it("a duplicate query key is 400 bad_request; it says nothing about the caller", async () => {
    const r = rig();
    const d = await pairDevice(r);
    for (const target of ["/v1/chat/history?a=1&a=2", "/v1/chat/history?a=1&%61=2"]) {
      const res = await r.app.inject({ method: "GET", url: target, headers: d.headers(r.clock, "GET", "/v1/chat/history") });
      expect(res.statusCode).toBe(400);
    }
    expect((await r.app.inject({ method: "GET", url: "/v1/chat/history?a=1&a=2" })).statusCode).toBe(400);
  });

  it("GET with a body is refused instead of hashing something the client did not sign", async () => {
    const r = rig();
    const d = await pairDevice(r);
    const res = await r.app.inject({ method: "GET", url: "/v1/chat/history", headers: { ...d.headers(r.clock, "GET", "/v1/chat/history"), "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(400);
  });

  it("body over 1 MB is 413 with the standard error shape", async () => {
    const r = rig();
    const d = await pairDevice(r);
    const big = JSON.stringify({ text: "x".repeat(1024 * 1024) });
    const res = await signedCall(r, d, "POST", "/v1/chat", big);
    expect(res.statusCode).toBe(413);
    expect(err(res).code).toBe("bad_request");
    const ok = await signedCall(r, d, "POST", "/v1/chat", JSON.stringify({ text: "x".repeat(1024 * 1024 - 20) }));
    expect(ok.statusCode).toBe(501);
  });

  it("paired and unpaired traffic use separate buckets", async () => {
    const r = rig({ limits: { unpaired: [2, 0.001], paired: [3, 0.001] } });
    const d = await pairDevice(r); // consumes none of the unpaired bucket? it does (1 token)
    // exhaust the unpaired bucket with garbage
    for (let i = 0; i < 5; i++) await r.app.inject({ method: "GET", url: "/v1/chat/history" });
    const bad = await r.app.inject({ method: "GET", url: "/v1/chat/history" });
    expect(bad.statusCode).toBe(429);
    // a valid signature is not blocked by the unpaired bucket and is charged to its own bucket
    const codes = [] as number[];
    for (let i = 0; i < 4; i++) codes.push((await signedCall(r, d, "GET", "/v1/chat/history")).statusCode);
    expect(codes).toEqual([501, 501, 501, 429]);
  });
});

describe("device revocation", () => {
  const revoke = (r: ReturnType<typeof rig>, caller: TestDevice, target: string, over: { ts?: number; bodyTs?: number; signer?: string; sigFrom?: TestDevice } = {}) => {
    const ts = over.ts ?? r.clock.t;
    const body = (over.sigFrom ?? caller).revokeBody(target, over.bodyTs ?? ts, over.signer ?? caller.id);
    return signedCall(r, caller, "POST", `/v1/devices/${target}/revoke`, body, { ts });
  };

  it("a device revokes another with an approval signature; the revoked one gets device_revoked and cannot pair-bypass", async () => {
    const r = rig();
    const a = await pairDevice(r, "Phone A");
    const b = await pairDevice(r, "Phone B");
    expect((await signedCall(r, b, "GET", "/v1/chat/history")).statusCode).toBe(501);
    const res = await revoke(r, a, b.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const after = await signedCall(r, b, "GET", "/v1/chat/history");
    expect(after.statusCode).toBe(401);
    expect(err(after).code).toBe("device_revoked");
    expect((await signedCall(r, a, "GET", "/v1/chat/history")).statusCode).toBe(501);
  });

  it("an unknown caller with a bad signature learns only unauthorized (device_revoked needs a valid signature)", async () => {
    const r = rig();
    const a = await pairDevice(r, "Phone A");
    const b = await pairDevice(r, "Phone B");
    await revoke(r, a, b.id);
    const forged = { ...b.headers(r.clock, "GET", "/v1/chat/history"), "x-vlad-sig": "MEUCIQC" };
    const res = await r.app.inject({ method: "GET", url: "/v1/chat/history", headers: forged });
    expect(err(res).code).toBe("unauthorized");
  });

  it("the session key alone cannot revoke (approval signature required)", async () => {
    const r = rig();
    const a = await pairDevice(r, "Phone A");
    const b = await pairDevice(r, "Phone B");
    const sessionSigned = JSON.stringify({ ts_ms: r.clock.t, signature: (await import("../helpers/client.ts")).signDer(a.session.priv, (await import("../../src/auth/canonical.ts")).revokeBytes({ device: b.id, signer: a.id, tsMs: r.clock.t })) });
    expect((await signedCall(r, a, "POST", `/v1/devices/${b.id}/revoke`, sessionSigned)).statusCode).toBe(401);
    expect((await signedCall(r, b, "GET", "/v1/chat/history")).statusCode).toBe(501);
  });

  it("another device's approval key cannot revoke on a caller's behalf, and signer/target/ts are all bound", async () => {
    const r = rig();
    const a = await pairDevice(r, "Phone A");
    const b = await pairDevice(r, "Phone B");
    const c = await pairDevice(r, "Phone C");
    expect((await revoke(r, a, c.id, { sigFrom: b })).statusCode).toBe(401); // b's approval key, a is the caller
    expect((await revoke(r, a, c.id, { signer: b.id })).statusCode).toBe(401); // signer != X-Vlad-Device
    expect((await revoke(r, a, c.id, { bodyTs: r.clock.t + 1 })).statusCode).toBe(401); // body ts != header ts
    const forTarget = a.revokeBody(b.id, r.clock.t);
    expect((await signedCall(r, a, "POST", `/v1/devices/${c.id}/revoke`, forTarget)).statusCode).toBe(401); // signed for another target
    expect((await signedCall(r, c, "GET", "/v1/chat/history")).statusCode).toBe(501);
  });

  it("(signer, ts) is single use; a replay with a new nonce is 401 even though the device is already revoked", async () => {
    const r = rig();
    const a = await pairDevice(r, "Phone A");
    const b = await pairDevice(r, "Phone B");
    const ts = r.clock.t;
    expect((await revoke(r, a, b.id, { ts })).statusCode).toBe(200);
    expect((await revoke(r, a, b.id, { ts })).statusCode).toBe(401);
    r.clock.t += 1; // a new ts is a new revocation: idempotent
    expect((await revoke(r, a, b.id)).statusCode).toBe(200);
  });

  it("revoke ts outside +-120 s is 401 and unknown target is 404 only after a valid approval signature", async () => {
    const r = rig();
    const a = await pairDevice(r, "Phone A");
    expect((await revoke(r, a, "nobody", { ts: r.clock.t + 121_000 })).statusCode).toBe(401);
    expect((await revoke(r, a, "nobody")).statusCode).toBe(404);
    const unsigned = await r.app.inject({ method: "POST", url: "/v1/devices/nobody/revoke", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(unsigned.statusCode).toBe(401);
  });

  it("the revocation survives a restart", async () => {
    let r = rig();
    const a = await pairDevice(r, "Phone A");
    const b = await pairDevice(r, "Phone B");
    await revoke(r, a, b.id);
    r = r.restart();
    expect(err(await signedCall(r, b, "GET", "/v1/chat/history")).code).toBe("device_revoked");
  });

  it("revoke body shape: extra fields or missing signature are 400", async () => {
    const r = rig();
    const a = await pairDevice(r, "Phone A");
    for (const body of ["{}", '{"ts_ms":1}', JSON.stringify({ ts_ms: r.clock.t, signature: "x", device_id: "d" }), "["]) {
      expect((await signedCall(r, a, "POST", "/v1/devices/d-x/revoke", body)).statusCode, body).toBe(400);
    }
  });
});

describe("trustProxy", () => {
  const hit = (port: number, xff: string) =>
    new Promise<number>((resolve, reject) => {
      const q = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/history", headers: { "x-forwarded-for": xff } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      q.on("error", reject);
      q.end();
    });

  it('"loopback": a client-written leftmost X-Forwarded-For entry cannot dodge the unpaired bucket; the proxy-appended one counts', async () => {
    const r = rig({ trustProxy: "loopback" });
    await r.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const port = (r.app.server.address() as { port: number }).port;
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) codes.push(await hit(port, `10.0.${i}.${i}, 203.0.113.9`)); // "<spoofed>, <appended by the proxy>"
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes[10]).toBe(429);
      // a different real client (rightmost) has its own bucket
      expect(await hit(port, "10.9.9.9, 203.0.113.10")).toBe(401);
    } finally {
      await r.app.close();
    }
  });
});
