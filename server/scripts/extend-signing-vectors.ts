// One-shot migration of ../contract/signing-vectors.json (v1 -> review round 2). Kept for provenance; do NOT rerun.
// Usage: node scripts/extend-signing-vectors.ts <vectors.json>
// - normalizes every well-formed DER signature to low-S (valid stays valid; invalid vectors then fail only for their stated reason)
// - duplicate query keys become errors; adds revoke, envelope path/nonce/DER-strictness and high-S vectors
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { encodeDer, P256_N, parseStrictDer } from "../src/auth/der.ts";
import { challengeBytes, envelopeString, revokeBytes } from "../src/auth/canonical.ts";

const file = process.argv[2]!;
const V = JSON.parse(readFileSync(file, "utf8"));
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb = (s: string) => Buffer.from(s, "base64url");

const lowS = (sigB64u: string): string => {
  const p = parseStrictDer(unb(sigB64u));
  return p && p.s > P256_N >> 1n ? b64u(encodeDer(p.r, P256_N - p.s)) : sigB64u;
};
for (const sec of ["envelope", "challenge", "grant"]) for (const v of V[sec]) v.signature_b64u = lowS(v.signature_b64u);

// 1. duplicate keys are errors
V.canonical_query = V.canonical_query.filter((v: { id: string }) => v.id !== "duplicate-keys-sorted-by-value");
V.canonical_query_errors.push(
  { id: "duplicate-key-same-value", raw_query: "a=1&a=1" },
  { id: "duplicate-key-different-value", raw_query: "a=2&a=1" },
  { id: "duplicate-key-after-decoding", raw_query: "a=1&%61=2" },
  { id: "duplicate-empty-key", raw_query: "a&a=" },
);

// new test-only keys (private halves are discarded with the process)
const mk = (id: string, note: string) => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  V.keys.push({ id, note, spki_b64u: b64u(publicKey.export({ type: "spki", format: "der" })) });
  return createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }));
};
const sessB = mk("session-b", "TEST ONLY: second device session key (path vectors)");
const apprB = mk("approval-b", "TEST ONLY: second device approval key (revoke vectors)");
const signLow = (key: ReturnType<typeof mk>, msg: Uint8Array | string): string => lowS(b64u(sign("sha256", Buffer.from(msg), { key, dsaEncoding: "der" })));

const NONCE = "AAECAwQFBgcICQoLDA0ODw";
const TS = 1761350400000;
const mkEnv = (id: string, description: string, path: string, sigPath: string, expect_valid: boolean) => {
  const input = { method: "GET", path, raw_query: "", ts_ms: TS, nonce: NONCE, body_b64u: "" };
  const str = (p: string) => envelopeString({ method: "GET", path: p, tsMs: TS, nonce: NONCE });
  return { id, description, key_id: "session-b", input, envelope_string: str(path), signature_b64u: signLow(sessB, str(sigPath)), expect_valid };
};
const base = V.envelope.find((v: { id: string }) => v.id === "env-get-empty-body");
const bp = parseStrictDer(unb(base.signature_b64u))!;
const withSig = (id: string, description: string, sig: Uint8Array) => ({ ...base, id, description, expect_valid: false, signature_b64u: b64u(sig) });
const r = bp.r, s = bp.s;
const intBytes = (v: bigint, pad = false) => { const e = encodeDer(v, 1n); const b = e.subarray(4, 4 + e[3]!); return pad ? Uint8Array.from([0, ...b]) : b; };
const seq = (rb: Uint8Array, sb: Uint8Array, longForm = false) => {
  const body = [0x02, rb.length, ...rb, 0x02, sb.length, ...sb];
  return Uint8Array.from(longForm ? [0x30, 0x81, body.length, ...body] : [0x30, body.length, ...body]);
};

V.envelope.push(
  mkEnv("env-path-encoded-slash", "raw path with %2F is signed verbatim", "/v1/cards/a%2Fb", "/v1/cards/a%2Fb", true),
  mkEnv("env-path-slash-vs-encoded-slash", "signature made for /a%2Fb presented with /a/b", "/v1/cards/a/b", "/v1/cards/a%2Fb", false),
  mkEnv("env-path-double-slash", "raw path with // is signed verbatim", "/v1//home", "/v1//home", true),
  mkEnv("env-path-double-slash-vs-single", "signature made for //home presented with /home", "/v1/home", "/v1//home", false),
  mkEnv("env-path-trailing-slash", "trailing slash is signed verbatim", "/v1/home/", "/v1/home/", true),
  mkEnv("env-path-trailing-slash-vs-none", "signature made for /home/ presented with /home", "/v1/home", "/v1/home/", false),
  withSig("env-high-s", "valid ECDSA signature with s replaced by n-s (high-S malleated twin): rejected, low-S required", encodeDer(r, P256_N - s)),
  withSig("env-der-leading-zero", "r padded with a redundant leading 0x00 (non-minimal DER)", seq(intBytes(r, true), intBytes(s))),
  withSig("env-der-long-form-length", "SEQUENCE length in long form (0x81 len)", seq(intBytes(r), intBytes(s), true)),
  withSig("env-der-trailing-bytes", "valid DER followed by one extra byte", Uint8Array.from([...encodeDer(r, s), 0x00])),
);
// leading-zero vector only counts if the padding is really redundant
{
  const rb = intBytes(r);
  if (rb[0]! & 0x80) throw new Error("r has high bit: pad would be required; pick another base signature");
}

V.envelope_errors = [
  { id: "nonce-21-chars", description: "nonce one character short", input: { method: "GET", path: "/v1/home", raw_query: "", ts_ms: TS, nonce: NONCE.slice(0, 21), body_b64u: "" } },
  { id: "nonce-23-chars", description: "nonce one character long", input: { method: "GET", path: "/v1/home", raw_query: "", ts_ms: TS, nonce: NONCE + "A", body_b64u: "" } },
  { id: "nonce-not-base64url", description: "22 characters but outside the base64url alphabet", input: { method: "GET", path: "/v1/home", raw_query: "", ts_ms: TS, nonce: NONCE.slice(0, 21) + "+", body_b64u: "" } },
  { id: "nonce-empty", description: "empty nonce", input: { method: "GET", path: "/v1/home", raw_query: "", ts_ms: TS, nonce: "", body_b64u: "" } },
  { id: "method-lowercase", description: "method must be upper case", input: { method: "get", path: "/v1/home", raw_query: "", ts_ms: TS, nonce: NONCE, body_b64u: "" } },
  { id: "path-with-query", description: "path must not carry the query", input: { method: "GET", path: "/v1/home?a=1", raw_query: "", ts_ms: TS, nonce: NONCE, body_b64u: "" } },
  { id: "duplicate-query-key", description: "repeated query key", input: { method: "GET", path: "/v1/home", raw_query: "a=1&a=2", ts_ms: TS, nonce: NONCE, body_b64u: "" } },
];

// challenge high-S twin
{
  const c = V.challenge.find((v: { id: string }) => v.id === "chal-valid");
  const p = parseStrictDer(unb(c.signature_b64u))!;
  V.challenge.push({ ...c, id: "chal-high-s", description: "valid signature with s replaced by n-s (high-S twin): rejected", signature_b64u: b64u(encodeDer(p.r, P256_N - p.s)), expect_valid: false });
}

// revoke
const rv = (id: string, description: string, f: { device: string; signer: string; tsMs: number }, signedFields: { device: string; signer: string; tsMs: number }, key: ReturnType<typeof mk>, expect_valid: boolean, mutate?: (s: string) => string) => {
  const sig = signLow(key, revokeBytes(signedFields));
  return { id, description, key_id: "approval-b", fields: { device: f.device, signer: f.signer, ts_ms: f.tsMs }, revoke_text: Buffer.from(revokeBytes(f)).toString("utf8"), signature_b64u: mutate ? mutate(sig) : sig, expect_valid };
};
const F = { device: "d-old-phone", signer: "d-pixel-9", tsMs: TS };
const hi = (sig: string) => { const p = parseStrictDer(unb(sig))!; return b64u(encodeDer(p.r, P256_N - p.s)); };
V.revoke = [
  rv("revoke-valid", "approval key of the signing device signs target+signer+ts", F, F, apprB, true),
  rv("revoke-signer-swapped", "signed with signer=d-pixel-9, presented as signer=d-other (replay by another device)", { ...F, signer: "d-other" }, F, apprB, false),
  rv("revoke-target-changed", "signed for d-old-phone, presented for d-tablet", { ...F, device: "d-tablet" }, F, apprB, false),
  rv("revoke-ts-changed", "ts changed after signing", { ...F, tsMs: TS + 1 }, F, apprB, false),
  rv("revoke-session-key", "signed by the session key, verified against the approval key", F, F, sessB, false),
  rv("revoke-high-s", "high-S twin of the valid signature", F, F, apprB, false, hi),
];
V.revoke_errors = [
  { id: "revoke-newline-injection", fields: { device: "d-old\nsigner=x", signer: "d-pixel-9", ts_ms: TS } },
  { id: "revoke-empty-device", fields: { device: "", signer: "d-pixel-9", ts_ms: TS } },
  { id: "revoke-bad-signer-alphabet", fields: { device: "d-old-phone", signer: "d pixel", ts_ms: TS } },
  { id: "revoke-negative-ts", fields: { device: "d-old-phone", signer: "d-pixel-9", ts_ms: -1 } },
];

V.vectors_version = 2;
V.signature_format = "ECDSA P-256, SHA-256, ASN.1 DER, base64url without padding. Accepted only if minimal short-form DER (no padding, no long form, no trailing bytes) AND low-S (s <= n/2); raw r||s, high-S and non-minimal DER are rejected";
V.note = "Read-only contract. Append new vectors, never change existing ones. Format: contract/README.md. Keys are TEST ONLY.";
void challengeBytes;
writeFileSync(file, JSON.stringify(V, null, 2) + "\n");
