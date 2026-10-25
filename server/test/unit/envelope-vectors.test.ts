import { describe, expect, it } from "vitest";
import { DeviceLedger } from "../../src/auth/devices.ts";
import { verifyEnvelope } from "../../src/auth/envelope.ts";
import { ReplayCache } from "../../src/auth/replay.ts";
import { envelopeString } from "../../src/auth/canonical.ts";
import { readJson } from "../helpers/contract.ts";
import { tmpState } from "../helpers/client.ts";

const V = readJson("signing-vectors.json");

/** Every `envelope` vector of the contract through the real `verifyEnvelope` (fresh state per vector). */
describe("verifyEnvelope against contract/signing-vectors.json", () => {
  for (const v of V.envelope) {
    it(`${v.id} -> ${v.expect_valid ? "ok" : "rejected"}`, () => {
      const dir = tmpState();
      const devices = new DeviceLedger(dir);
      const key = V.keys.find((k: any) => k.id === v.key_id);
      devices.add({ device_id: "dev1", device_name: "t", session_pub: key.spki_b64u, approval_pub: key.spki_b64u + "x", created: "2026-10-25T00:00:00Z" });
      const i = v.input;
      const target = i.raw_query ? `${i.path}?${i.raw_query}` : i.path;
      const res = verifyEnvelope(
        { devices, replay: new ReplayCache(dir, () => i.ts_ms), now: () => i.ts_ms },
        {
          method: i.method,
          rawUrl: target,
          headers: { "x-vlad-device": "dev1", "x-vlad-ts": String(i.ts_ms), "x-vlad-nonce": i.nonce, "x-vlad-sig": v.signature_b64u },
          body: Buffer.from(i.body_b64u ?? "", "base64url"),
        },
      );
      // sanity: the vector's own string is what we verify
      expect(envelopeString({ method: i.method, path: i.path, rawQuery: i.raw_query, tsMs: i.ts_ms, nonce: i.nonce, body: Buffer.from(i.body_b64u ?? "", "base64url") })).toBe(v.envelope_string);
      expect(res.ok).toBe(v.expect_valid);
    });
  }
});
