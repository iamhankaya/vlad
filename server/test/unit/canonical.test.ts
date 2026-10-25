import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CanonicalError, canonicalQuery, challengeBytes, envelopeString, parseChallengeBytes, sha256Hex } from "../../src/auth/canonical.ts";
import { verifyDer } from "../helpers/contract.ts";

const fields = {
  action_id: "A-7Q2M9K4X", kind: "merge_phase", repo: "iamhankaya/vlad", pr: "42", base: "vlad/T20261024-94",
  head_sha: "0123456789abcdef0123456789abcdef01234567", task: "T20261025-61", nonce: "AAECAwQFBgcICQoLDA0ODw", exp: "1761350460",
};
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("server: canonical query", () => {
  it("sorts, dedups nothing, normalizes encoding", () => {
    expect(canonicalQuery("b=2&a=2&a=1")).toBe("a=1&a=2&b=2");
    expect(canonicalQuery("q=a+b&r=a%20b&s=a%2Bb")).toBe("q=a%20b&r=a%20b&s=a%2Bb");
    expect(canonicalQuery("a&b=")).toBe("a=&b=");
  });
  it("rejects malformed percent encoding and invalid UTF-8", () => {
    for (const q of ["a=%", "a=%2", "a=%zz", "a=%FF"]) expect(() => canonicalQuery(q)).toThrow(CanonicalError);
  });
  it("is idempotent", () => {
    const once = canonicalQuery("z=%C3%BC&a=1+2&a=");
    expect(canonicalQuery(once)).toBe(once);
  });
});

describe("server: envelope string", () => {
  const base = { method: "POST", path: "/v1/chat", tsMs: 1761350400000, nonce: "AAECAwQFBgcICQoLDA0ODw" };
  it("has the six fixed lines and hashes raw bytes", () => {
    const body = Buffer.from('{"a": 1}'); // spacing matters: hash is over bytes, not parsed JSON
    expect(envelopeString({ ...base, body }).split("\n")).toEqual(["v1", "POST", "/v1/chat", "1761350400000", base.nonce, sha256Hex(body)]);
    expect(sha256Hex(body)).not.toBe(sha256Hex('{"a":1}'));
  });
  it("empty body is sha256 of the empty string", () => {
    expect(envelopeString(base).endsWith("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toBe(true);
  });
  it("appends the canonical query to the path", () => {
    expect(envelopeString({ ...base, method: "GET", rawQuery: "?b=2&a=1" }).split("\n")[2]).toBe("/v1/chat?a=1&b=2");
  });
  it("rejects lowercase method, bad path, bad nonce, bad ts", () => {
    expect(() => envelopeString({ ...base, method: "post" })).toThrow(CanonicalError);
    expect(() => envelopeString({ ...base, path: "v1/chat" })).toThrow(CanonicalError);
    expect(() => envelopeString({ ...base, path: "/v1/chat?x=1" })).toThrow(CanonicalError);
    expect(() => envelopeString({ ...base, nonce: "a b" })).toThrow(CanonicalError);
    expect(() => envelopeString({ ...base, tsMs: -1 })).toThrow(CanonicalError);
  });
});

describe("server: challenge bytes", () => {
  it("is the fixed header plus fields in fixed order, regardless of object key order", () => {
    const shuffled = Object.fromEntries(Object.entries(fields).reverse());
    expect(dec(challengeBytes(shuffled))).toBe(["vlad-approve/v1", ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join("\n"));
  });
  it("parse is the strict inverse", () => {
    expect(parseChallengeBytes(challengeBytes(fields))).toEqual(fields);
  });
  it("rejects missing, extra, off-alphabet and newline-injected fields", () => {
    const { exp: _exp, ...missing } = fields;
    expect(() => challengeBytes(missing)).toThrow(CanonicalError);
    expect(() => challengeBytes({ ...fields, extra: "x" })).toThrow(CanonicalError);
    expect(() => challengeBytes({ ...fields, repo: "a/b\nexp=1" })).toThrow(CanonicalError);
    expect(() => challengeBytes({ ...fields, base: "vlad/x y" })).toThrow(CanonicalError);
    expect(() => challengeBytes({ ...fields, head_sha: "0123" })).toThrow(CanonicalError);
  });
  it("parse rejects reordered fields, wrong header and trailing newline", () => {
    const text = dec(challengeBytes(fields));
    const lines = text.split("\n");
    const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)].join("\n");
    for (const bad of [swapped, text.replace("v1", "v2"), text + "\n", lines.slice(0, -1).join("\n"), text + "\nextra=1"]) {
      expect(() => parseChallengeBytes(new TextEncoder().encode(bad))).toThrow(CanonicalError);
    }
  });
});

describe("server: signing round trip (generation direction)", () => {
  it("a freshly generated P-256 DER signature verifies; raw r||s and altered bytes do not", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    const msg = envelopeString({ method: "GET", path: "/v1/home", tsMs: 1761350400000, nonce: "AAECAwQFBgcICQoLDA0ODw" });
    const der = sign("sha256", Buffer.from(msg), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    const raw = sign("sha256", Buffer.from(msg), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    expect(verifyDer(spki, msg, der)).toBe(true);
    expect(verifyDer(spki, msg + "x", der)).toBe(false);
    expect(verifyDer(spki, msg, raw)).toBe(false);
    const ch = challengeBytes(fields);
    const chSig = sign("sha256", Buffer.from(ch), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    expect(verifyDer(spki, ch, chSig)).toBe(true);
  });
});
