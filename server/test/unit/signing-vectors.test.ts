import { describe, expect, it } from "vitest";
import { canonicalQuery, challengeBytes, envelopeString, parseChallengeBytes, sha256Hex } from "../../src/auth/canonical.ts";
import { readJson, verifyDer } from "../helpers/contract.ts";

type R = Record<string, any>;
type Keyed = { key_id: string; signature_b64u: string; expect_valid: boolean; id: string };
const V = readJson("signing-vectors.json");
const spki = (id: string): string => V.keys.find((k: { id: string }) => k.id === id).spki_b64u;

describe("server: signing vectors verify (valid/invalid set)", () => {
  it("has the documented sections and test-only keys", () => {
    expect(V.vectors_version).toBe(1);
    for (const k of ["keys", "canonical_query", "canonical_query_errors", "body_hash", "envelope", "challenge", "grant"]) expect(V[k].length).toBeGreaterThan(0);
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
      for (const c of ["tampered-body", "wrong-key", "bad-der", "raw-r-s"]) expect(ids).toContain(c);
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

  describe("grant", () => {
    it.each(V.grant as R[])("$id", (v) => {
      expect(verifyDer(spki(v.key_id), v.payload, v.signature_b64u)).toBe(v.expect_valid);
    });
  });
});
