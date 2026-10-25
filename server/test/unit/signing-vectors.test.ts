import { describe, expect, it } from "vitest";
import { canonicalQuery, challengeBytes, envelopeString, parseChallengeBytes, revokeBytes, sha256Hex, takeoverBytes } from "../../src/auth/canonical.ts";
import { isCanonicalSignature } from "../../src/auth/der.ts";
import { readJson, verifyDer } from "../helpers/contract.ts";

type R = Record<string, any>;
type Keyed = { key_id: string; signature_b64u: string; expect_valid: boolean; id: string };
const V = readJson("signing-vectors.json");
const spki = (id: string): string => V.keys.find((k: { id: string }) => k.id === id).spki_b64u;

describe("server: signing vectors verify (valid/invalid set)", () => {
  it("has the documented sections and test-only keys", () => {
    expect(V.vectors_version).toBe(2);
    for (const k of ["keys", "canonical_query", "canonical_query_errors", "body_hash", "envelope", "envelope_errors", "challenge", "grant", "revoke", "revoke_errors", "takeover", "takeover_errors"]) expect(V[k].length).toBeGreaterThan(0);
    expect(V.keys.every((k: { note: string }) => k.note.startsWith("TEST ONLY"))).toBe(true);
    expect(JSON.stringify(V)).not.toMatch(/PRIVATE KEY|"priv/);
  });

  it.each(V.canonical_query as R[])("canonical query: $id", (v) => {
    expect(canonicalQuery(v.raw_query)).toBe(v.expected);
  });
  it.each(V.canonical_query_errors as R[])("canonical query error: $id", (v) => {
    expect(() => canonicalQuery(v.raw_query)).toThrow();
  });
  it.each(V.body_hash as R[])("body hash is over raw bytes: $id", (v) => {
    expect(sha256Hex(Buffer.from(v.body_b64u, "base64url"))).toBe(v.sha256_hex);
  });
  it("empty body is sha256 of the empty string", () => {
    expect(V.body_hash.find((v: { id: string }) => v.id === "empty").sha256_hex).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  describe("envelope", () => {
    it.each(V.envelope as R[])("$id", (v) => {
      const i = v.input;
      const s = envelopeString({ method: i.method, path: i.path, rawQuery: i.raw_query, tsMs: i.ts_ms, nonce: i.nonce, body: Buffer.from(i.body_b64u, "base64url") });
      expect(s).toBe(v.envelope_string);
      expect(verifyDer(spki(v.key_id), s, v.signature_b64u)).toBe(v.expect_valid);
    });
    it("covers the required invalid classes", () => {
      const ids = V.envelope.filter((v: Keyed) => !v.expect_valid).map((v: Keyed) => v.id).join(" ");
      for (const c of ["tampered-body", "wrong-key", "bad-der", "raw-r-s", "high-s", "leading-zero", "long-form", "trailing-bytes", "encoded-slash", "double-slash", "trailing-slash"]) expect(ids).toContain(c);
    });
    it.each(V.envelope_errors as R[])("rejects: $id", (v) => {
      const i = v.input;
      expect(() => envelopeString({ method: i.method, path: i.path, rawQuery: i.raw_query, tsMs: i.ts_ms, nonce: i.nonce, body: Buffer.from(i.body_b64u, "base64url") })).toThrow();
    });
    it("every valid envelope signature is minimal DER with low-S", () => {
      for (const v of V.envelope as Keyed[]) if (v.expect_valid) expect(isCanonicalSignature(Buffer.from(v.signature_b64u, "base64url")), v.id).toBe(true);
    });
  });

  describe("challenge", () => {
    it.each(V.challenge as R[])("$id", (v) => {
      const bytes = challengeBytes(v.fields);
      expect(Buffer.from(bytes).toString("utf8")).toBe(v.challenge_text);
      expect(parseChallengeBytes(bytes)).toEqual(v.fields);
      expect(verifyDer(spki(v.key_id), bytes, v.signature_b64u)).toBe(v.expect_valid);
    });
  });

  describe("revoke", () => {
    it.each(V.revoke as R[])("$id", (v) => {
      const bytes = revokeBytes({ device: v.fields.device, signer: v.fields.signer, tsMs: v.fields.ts_ms });
      expect(Buffer.from(bytes).toString("utf8")).toBe(v.revoke_text);
      expect(verifyDer(spki(v.key_id), bytes, v.signature_b64u)).toBe(v.expect_valid);
    });
    it.each(V.revoke_errors as R[])("rejects: $id", (v) => {
      expect(() => revokeBytes({ device: v.fields.device, signer: v.fields.signer, tsMs: v.fields.ts_ms })).toThrow();
    });
  });

  describe("takeover", () => {
    it.each(V.takeover as R[])("$id", (v) => {
      const bytes = takeoverBytes({ signer: v.fields.signer, tsMs: v.fields.ts_ms });
      expect(Buffer.from(bytes).toString("utf8")).toBe(v.takeover_text);
      expect(verifyDer(spki(v.key_id), bytes, v.signature_b64u)).toBe(v.expect_valid);
    });
    it.each(V.takeover_errors as R[])("rejects: $id", (v) => {
      expect(() => takeoverBytes({ signer: v.fields.signer, tsMs: v.fields.ts_ms })).toThrow();
    });
  });

  describe("grant", () => {
    it.each(V.grant as R[])("$id", (v) => {
      expect(verifyDer(spki(v.key_id), v.payload, v.signature_b64u)).toBe(v.expect_valid);
    });
  });
});
