import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grantSigningPayload } from "../../src/grants/store.js";

// contract/signing-vectors.json `grant` section pins the bytes the approval key signs; src/grants/store.ts is the
// (strict DER / low-S is enforced by server/test; here Node's verifier is enough to pin the payload bytes)
// single source of those bytes, so the vector must equal grantSigningPayload() byte for byte.
const V = JSON.parse(readFileSync(new URL("../../contract/signing-vectors.json", import.meta.url), "utf8"));
const spki = (id: string): string => V.keys.find((k: { id: string }) => k.id === id).spki_b64u;
const ok = (keyId: string, msg: string, sig: string): boolean => {
  try {
    const key = createPublicKey({ key: Buffer.from(spki(keyId), "base64url"), format: "der", type: "spki" });
    return verify("sha256", Buffer.from(msg), { key, dsaEncoding: "der" }, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
};

describe("contract: grant signing vector", () => {
  const valid = V.grant.find((g: { id: string }) => g.id === "grant-valid");

  it("payload equals grantSigningPayload() for the vector's grant (conditions sorted)", () => {
    expect(grantSigningPayload(valid.input)).toBe(valid.payload);
    expect(grantSigningPayload({ ...valid.input, conditions: [...valid.input.conditions].reverse() })).toBe(valid.payload);
  });

  it("every grant vector verifies as declared against the payload grantSigningPayload() produces", () => {
    for (const g of V.grant) expect(ok(g.key_id, grantSigningPayload(g.input), g.signature_b64u), g.id).toBe(g.expect_valid);
  });
});
