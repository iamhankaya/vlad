import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelopeString, revokeBytes } from "../../src/auth/canonical.ts";
import { encodeDer, P256_N } from "../../src/auth/der.ts";
import { PairingCodes } from "../../src/auth/pairing.ts";
import { buildApp, type AppConfig } from "../../src/http/app.ts";

export const tmpState = () => mkdtempSync(join(tmpdir(), "vlad-srv-"));

export class Clock {
  t: number;
  constructor(t = 1_761_350_400_000) {
    this.t = t;
  }
  now = () => this.t;
}

/** DER + low-S, exactly what the Android client has to produce. */
export function signDer(priv: KeyObject, msg: Uint8Array): string {
  const raw = sign("sha256", msg, { key: priv, dsaEncoding: "ieee-p1363" });
  const r = BigInt("0x" + raw.subarray(0, 32).toString("hex"));
  let s = BigInt("0x" + raw.subarray(32).toString("hex"));
  if (s > P256_N >> 1n) s = P256_N - s;
  return Buffer.from(encodeDer(r, s)).toString("base64url");
}

const newKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { priv: privateKey, pub: Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64url") };
};

export class TestDevice {
  session = newKey();
  approval = newKey();
  id = "";
  name: string;
  constructor(name = "Pixel 9") {
    this.name = name;
  }

  /** Headers for a signed request. `target` is the raw request target (path + optional query), signed verbatim. */
  headers(clock: Clock, method: string, target: string, body = "", over: { ts?: number; nonce?: string; device?: string } = {}) {
    const q = target.indexOf("?");
    const ts = over.ts ?? clock.t;
    const nonce = over.nonce ?? randomBytes(16).toString("base64url");
    const msg = envelopeString({ method, path: q < 0 ? target : target.slice(0, q), rawQuery: q < 0 ? "" : target.slice(q + 1), tsMs: ts, nonce, body: Buffer.from(body) });
    return { "x-vlad-device": over.device ?? this.id, "x-vlad-ts": String(ts), "x-vlad-nonce": nonce, "x-vlad-sig": signDer(this.session.priv, Buffer.from(msg)) };
  }

  revokeBody(target: string, tsMs: number, signer = this.id) {
    return JSON.stringify({ ts_ms: tsMs, signature: signDer(this.approval.priv, revokeBytes({ device: target, signer, tsMs })) });
  }
}

export type Rig = { app: FastifyInstance; clock: Clock; dir: string; cfg: AppConfig; codes: PairingCodes; restart: () => Rig };

export function rig(over: Partial<AppConfig> = {}, dir = tmpState(), clock = new Clock()): Rig {
  const cfg: AppConfig = { stateDir: dir, version: "0.0.0-test", now: clock.now, ...over };
  const app = buildApp(cfg);
  const r: Rig = { app, clock, dir, cfg, codes: new PairingCodes(dir, clock.now), restart: () => rig(over, dir, clock) };
  return r;
}

export async function signedCall(r: Rig, d: TestDevice, method: string, target: string, body?: string, over?: Parameters<TestDevice["headers"]>[4]) {
  const h = d.headers(r.clock, method, target, body ?? "", over);
  const res = await r.app.inject({ method: method as "GET", url: target, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: body } : {}) });
  return res;
}

export async function pairDevice(r: Rig, name = "Pixel 9"): Promise<TestDevice> {
  const d = new TestDevice(name);
  const { code } = r.codes.issue();
  const res = await r.app.inject({
    method: "POST",
    url: "/v1/pair",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ code, device_name: name, session_pub: d.session.pub, approval_pub: d.approval.pub }),
  });
  if (res.statusCode !== 200) throw new Error(`pair failed: ${res.statusCode} ${res.body}`);
  d.id = res.json().device_id;
  return d;
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
