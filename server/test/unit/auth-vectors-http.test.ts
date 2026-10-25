import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyRevokeApproval } from "../../src/auth/envelope.ts";
import { ReplayCache } from "../../src/auth/replay.ts";
import { buildApp } from "../../src/http/app.ts";
import { pairDevice, rig, signedCall, tmpState } from "../helpers/client.ts";
import { readJson } from "../helpers/contract.ts";

const V = readJson("signing-vectors.json");

/** Real HTTP requests (inject) for every envelope vector: valid ones authenticate (then 404, the path is no route), invalid ones are 400/401. */
describe("envelope vectors over HTTP", () => {
  for (const v of V.envelope) {
    it(`${v.id}`, async () => {
      const dir = tmpState();
      mkdirSync(dir, { recursive: true });
      const key = V.keys.find((k: any) => k.id === v.key_id);
      writeFileSync(join(dir, "devices.json"), JSON.stringify({ devices: [{ device_id: "dev1", device_name: "t", session_pub: key.spki_b64u, approval_pub: "x", created: "2026-10-25T00:00:00Z" }] }));
      const i = v.input;
      const app = buildApp({ stateDir: dir, version: "t", now: () => i.ts_ms, limits: { unpaired: [1000, 1000] } });
      const res = await app.inject({
        method: i.method,
        url: i.raw_query ? `${i.path}?${i.raw_query}` : i.path,
        headers: { "x-vlad-device": "dev1", "x-vlad-ts": String(i.ts_ms), "x-vlad-nonce": i.nonce, "x-vlad-sig": v.signature_b64u, "content-type": "application/octet-stream" },
        payload: Buffer.from(i.body_b64u ?? "", "base64url"),
      });
      // a valid signature reaches the handler: 501/404, or the S6c read handler's own answer (no VLAD_HOME here: 503; bad id: 400)
      if (v.expect_valid) expect([404, 501, 503, 400]).toContain(res.statusCode);
      else expect([400, 401]).toContain(res.statusCode);
    });
  }
});

describe("revoke vectors", () => {
  for (const v of V.revoke) {
    it(`${v.id} -> ${v.expect_valid ? "valid" : "rejected"}`, () => {
      const key = V.keys.find((k: any) => k.id === v.key_id);
      const dir = tmpState();
      const caller = { device_id: v.fields.signer, device_name: "t", session_pub: "x", approval_pub: key.spki_b64u, created: "x" };
      const why = verifyRevokeApproval({ replay: new ReplayCache(dir, () => v.fields.ts_ms) }, caller, v.fields.device, v.fields.ts_ms, { ts_ms: v.fields.ts_ms, signature: v.signature_b64u });
      expect(why === null).toBe(v.expect_valid);
    });
  }
  it("a valid revoke vector cannot be used twice", () => {
    const v = V.revoke.find((x: any) => x.expect_valid);
    const key = V.keys.find((k: any) => k.id === v.key_id);
    const caller = { device_id: v.fields.signer, device_name: "t", session_pub: "x", approval_pub: key.spki_b64u, created: "x" };
    const replay = new ReplayCache(tmpState(), () => v.fields.ts_ms);
    const body = { ts_ms: v.fields.ts_ms, signature: v.signature_b64u };
    expect(verifyRevokeApproval({ replay }, caller, v.fields.device, v.fields.ts_ms, body)).toBeNull();
    expect(verifyRevokeApproval({ replay }, caller, v.fields.device, v.fields.ts_ms, body)).toBe("revoke_replay");
  });
});

describe("extra acceptance", () => {
  it("nonce of 21 or 23 characters is rejected", async () => {
    const r = rig();
    const d = await pairDevice(r);
    for (const nonce of ["A".repeat(21), "A".repeat(23)]) {
      const res = await r.app.inject({ method: "GET", url: "/v1/grants", headers: { "x-vlad-device": d.id, "x-vlad-ts": String(r.clock.t), "x-vlad-nonce": nonce, "x-vlad-sig": "MEUCIQC" } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("skew 119 s passes, 121 s fails", async () => {
    const r = rig();
    const d = await pairDevice(r);
    expect((await signedCall(r, d, "GET", "/v1/grants", undefined, { ts: r.clock.t - 119_000 })).statusCode).toBe(501);
    expect((await signedCall(r, d, "GET", "/v1/grants", undefined, { ts: r.clock.t + 121_000 })).statusCode).toBe(401);
  });

  it("bad signatures and replays never reach the replay log", async () => {
    const r = rig();
    const d = await pairDevice(r);
    for (let i = 0; i < 5; i++) await r.app.inject({ method: "GET", url: "/v1/grants", headers: { ...d.headers(r.clock, "GET", "/v1/grants"), "x-vlad-sig": "MEUCIQC" } });
    expect((await import("node:fs")).readFileSync(join(r.dir, "replay.log"), "utf8")).toBe("");
  });

  it("after revocation both keys of that device are dead: session requests and a revoke signed by its approval key", async () => {
    const r = rig();
    const a = await pairDevice(r, "A");
    const b = await pairDevice(r, "B");
    expect((await signedCall(r, a, "POST", `/v1/devices/${b.id}/revoke`, a.revokeBody(b.id, r.clock.t))).statusCode).toBe(200);
    r.clock.t += 1000;
    const res = await signedCall(r, b, "POST", `/v1/devices/${a.id}/revoke`, b.revokeBody(a.id, r.clock.t));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("device_revoked");
    expect((await signedCall(r, a, "GET", "/v1/grants")).statusCode).toBe(501);
  });

  it("two codes pair two devices; one code redeemed concurrently pairs exactly one", async () => {
    const r = rig();
    const c1 = r.codes.issue().code;
    const c2 = r.codes.issue().code;
    const { TestDevice } = await import("../helpers/client.ts");
    const go = (code: string, name: string) => {
      const d = new TestDevice(name);
      return r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload: JSON.stringify({ code, device_name: name, session_pub: d.session.pub, approval_pub: d.approval.pub }) });
    };
    const both = await Promise.all([go(c1, "One"), go(c2, "Two")]);
    expect(both.map((x) => x.statusCode)).toEqual([200, 200]);
    const c3 = r.codes.issue().code;
    const race = await Promise.all([go(c3, "Three"), go(c3, "Four")]);
    expect(race.map((x) => x.statusCode).sort()).toEqual([200, 401]);
  });

  it("device_name and fcm_token are validated", async () => {
    const r = rig({ limits: { unpaired: [1000, 1000] } });
    const { TestDevice } = await import("../helpers/client.ts");
    const d = new TestDevice();
    const go = (over: object) => r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload: JSON.stringify({ code: r.codes.issue().code, device_name: "P", session_pub: d.session.pub, approval_pub: d.approval.pub, ...over }) });
    for (const bad of [{ device_name: "" }, { device_name: "x".repeat(65) }, { device_name: "a\nb" }, { device_name: 5 }, { fcm_token: "" }, { fcm_token: "t".repeat(4097) }, { fcm_token: 7 }]) expect((await go(bad)).statusCode, JSON.stringify(bad).slice(0, 40)).toBe(400);
    expect((await go({ device_name: "x".repeat(64), fcm_token: "t".repeat(4096) })).statusCode).toBe(200);
  });
});
