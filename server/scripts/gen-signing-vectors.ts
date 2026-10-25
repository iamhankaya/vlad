// One-shot generator for ../contract/signing-vectors.json. The committed file is the contract and is read-only:
// do NOT regenerate it (ECDSA signatures are random, regenerating changes every vector). New vectors are appended.
// Usage: node scripts/gen-signing-vectors.ts <out.json>   (private keys are discarded after generation)
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { canonicalQuery, challengeBytes, envelopeString, sha256Hex } from "../src/auth/canonical.ts";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const mkKey = (id: string, note: string) => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { id, note, spki_b64u: b64u(publicKey.export({ type: "spki", format: "der" })), priv: createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" })) };
};
const keys = [
  mkKey("session-a", "TEST ONLY: device session key"),
  mkKey("approval-a", "TEST ONLY: device approval key"),
  mkKey("other", "TEST ONLY: unrelated key (wrong-key vectors)"),
];
const key = (id: string) => keys.find((k) => k.id === id)!;
const signDer = (id: string, msg: string | Uint8Array) => sign("sha256", Buffer.from(msg), { key: key(id).priv, dsaEncoding: "der" });
const signRaw = (id: string, msg: string | Uint8Array) => sign("sha256", Buffer.from(msg), { key: key(id).priv, dsaEncoding: "ieee-p1363" });

const NONCE = "AAECAwQFBgcICQoLDA0ODw";
const TS = 1761350400000;
const json = (o: unknown) => Buffer.from(JSON.stringify(o));

type Env = { method: string; path: string; raw_query: string; ts_ms: number; nonce: string; body_b64u: string };
const env = (method: string, path: string, raw_query: string, body: Uint8Array, over: Partial<Env> = {}): Env => ({ method, path, raw_query, ts_ms: TS, nonce: NONCE, body_b64u: b64u(body), ...over });
const envStr = (e: Env) => envelopeString({ method: e.method, path: e.path, rawQuery: e.raw_query, tsMs: e.ts_ms, nonce: e.nonce, body: Buffer.from(e.body_b64u, "base64url") });

const chalFields = {
  action_id: "A-7Q2M9K4X", kind: "merge_phase", repo: "iamhankaya/vlad", pr: "42", base: "vlad/T20261024-94",
  head_sha: "0123456789abcdef0123456789abcdef01234567", task: "T20261025-61", nonce: "AAECAwQFBgcICQoLDA0ODw", exp: "1761350460",
};

const getEnv = env("GET", "/v1/home", "", new Uint8Array());
const postBody = json({ client_msg_id: "m-1", text: "Merhaba" });
const postEnv = env("POST", "/v1/chat", "", postBody);
const queryEnv = env("GET", "/v1/projects", "b=2&a=1&a=%C3%BC", new Uint8Array());
const tamperedBody = json({ client_msg_id: "m-1", text: "Merhabb" });

const envelope = [
  { id: "env-get-empty-body", desc: "GET, empty body hashes sha256(\"\")", key: "session-a", input: getEnv, sig: signDer("session-a", envStr(getEnv)), expect_valid: true },
  { id: "env-post-json-body", desc: "POST with raw JSON body bytes", key: "session-a", input: postEnv, sig: signDer("session-a", envStr(postEnv)), expect_valid: true },
  { id: "env-unsorted-query-signs-canonical", desc: "client signs canonical query; raw order on the wire is irrelevant", key: "session-a", input: queryEnv, sig: signDer("session-a", envStr(queryEnv)), expect_valid: true },
  { id: "env-tampered-body-byte", desc: "body byte changed after signing", key: "session-a", input: env("POST", "/v1/chat", "", tamperedBody), sig: signDer("session-a", envStr(postEnv)), expect_valid: false },
  { id: "env-tampered-method", desc: "method changed after signing", key: "session-a", input: env("DELETE", "/v1/home", "", new Uint8Array()), sig: signDer("session-a", envStr(getEnv)), expect_valid: false },
  { id: "env-tampered-ts", desc: "ts_ms changed after signing", key: "session-a", input: env("GET", "/v1/home", "", new Uint8Array(), { ts_ms: TS + 1 }), sig: signDer("session-a", envStr(getEnv)), expect_valid: false },
  { id: "env-wrong-key", desc: "signed by an unrelated key", key: "session-a", input: getEnv, sig: signDer("other", envStr(getEnv)), expect_valid: false },
  { id: "env-bad-der-truncated", desc: "DER signature truncated", key: "session-a", input: getEnv, sig: signDer("session-a", envStr(getEnv)).subarray(0, 40), expect_valid: false },
  { id: "env-bad-der-wrong-tag", desc: "DER sequence tag replaced", key: "session-a", input: getEnv, sig: Buffer.concat([Buffer.from([0x31]), signDer("session-a", envStr(getEnv)).subarray(1)]), expect_valid: false },
  { id: "env-raw-r-s", desc: "valid signature in raw r||s (IEEE P1363, 64 bytes) instead of DER", key: "session-a", input: getEnv, sig: signRaw("session-a", envStr(getEnv)), expect_valid: false },
].map((v) => ({ id: v.id, description: v.desc, key_id: v.key, input: v.input, envelope_string: envStr(v.input), signature_b64u: b64u(v.sig), expect_valid: v.expect_valid }));

const chalBytes = challengeBytes(chalFields);
const chalTampered = challengeBytes({ ...chalFields, pr: "43" });
const challenge = [
  { id: "chal-valid", desc: "approval key signs the stored challenge bytes", key: "approval-a", fields: chalFields, sig: signDer("approval-a", chalBytes), expect_valid: true },
  { id: "chal-session-key", desc: "signed by the session key; verification against the approval key fails", key: "approval-a", fields: chalFields, sig: signDer("session-a", chalBytes), expect_valid: false },
  { id: "chal-tampered-field", desc: "pr changed after signing", key: "approval-a", fields: { ...chalFields, pr: "43" }, sig: signDer("approval-a", chalBytes), expect_valid: false },
  { id: "chal-wrong-key", desc: "signed by an unrelated key", key: "approval-a", fields: chalFields, sig: signDer("other", chalBytes), expect_valid: false },
  { id: "chal-bad-der-truncated", desc: "DER signature truncated", key: "approval-a", fields: chalFields, sig: signDer("approval-a", chalBytes).subarray(0, 30), expect_valid: false },
  { id: "chal-raw-r-s", desc: "valid signature in raw r||s", key: "approval-a", fields: chalFields, sig: signRaw("approval-a", chalBytes), expect_valid: false },
].map((v) => ({ id: v.id, description: v.desc, key_id: v.key, fields: v.fields, challenge_text: Buffer.from(challengeBytes(v.fields)).toString("utf8"), signature_b64u: b64u(v.sig), expect_valid: v.expect_valid }));
void chalTampered;

const qs: [string, string, string][] = [
  ["empty", "", ""],
  ["leading-question-mark", "?a=1", "a=1"],
  ["sorted", "b=2&a=1", "a=1&b=2"],
  ["duplicate-keys-sorted-by-value", "a=2&a=1&a=1", "a=1&a=1&a=2"],
  ["empty-value", "a=&b", "a=&b="],
  ["empty-segments-dropped", "&&a=1&", "a=1"],
  ["percent-decoded-and-reencoded-uppercase", "a=%c3%bc", "a=%C3%BC"],
  ["unreserved-escaped-is-decoded", "a=%41%7e", "a=A~"],
  ["plus-is-space", "q=a+b", "q=a%20b"],
  ["percent20-is-space", "q=a%20b", "q=a%20b"],
  ["literal-plus-via-percent2b", "q=a%2Bb", "q=a%2Bb"],
  ["case-sensitive-keys-byte-order", "a=1&B=2&A=3", "A=3&B=2&a=1"],
  ["equals-in-value", "a=b=c", "a=b%3Dc"],
  ["encoded-delimiters", "a=%26%3D%23", "a=%26%3D%23"],
  ["utf8-key", "%C3%BC=1&z=2", "z=2&%C3%BC=1"],
  ["astral-vs-bmp-byte-order", "%F0%9F%98%80=1&%EF%BD%A1=2", "%EF%BD%A1=2&%F0%9F%98%80=1"],
];
const canonical_query = qs.map(([id, raw, exp]) => {
  if (canonicalQuery(raw) !== exp) throw new Error(`generator disagrees on ${id}: ${canonicalQuery(raw)}`);
  return { id, raw_query: raw, expected: exp };
});
const canonical_query_errors = [
  { id: "truncated-percent", raw_query: "a=%2" },
  { id: "non-hex-percent", raw_query: "a=%zz" },
  { id: "lone-percent", raw_query: "a=%" },
  { id: "invalid-utf8", raw_query: "a=%FF" },
];

const bodies: [string, Uint8Array][] = [
  ["empty", new Uint8Array()],
  ["json", postBody],
  ["utf8-turkish", Buffer.from("İıŞşĞğ", "utf8")],
  ["binary-non-utf8", Uint8Array.from([0xff, 0x00, 0x80, 0xfe])],
];
const body_hash = bodies.map(([id, b]) => ({ id, body_b64u: b64u(b), sha256_hex: sha256Hex(b) }));

const grantInput = { id: "G-001", scope: { type: "project", ref: "vlad" }, action: "merge_phase", conditions: ["no_severe_findings", "ci_green"], created: "2026-10-25T12:00:00Z", expires: "2026-11-24T12:00:00Z", max_uses: 5 };
const grantPayload = ["vlad-grant/v1", `id=${grantInput.id}`, `scope=project:vlad`, `action=merge_phase`, `conditions=ci_green,no_severe_findings`, `created=${grantInput.created}`, `expires=${grantInput.expires}`, `max_uses=5`].join("\n");
const grant = [
  { id: "grant-valid", description: "approval key signs grantSigningPayload (conditions sorted)", key_id: "approval-a", input: grantInput, payload: grantPayload, signature_b64u: b64u(signDer("approval-a", grantPayload)), expect_valid: true },
  { id: "grant-tampered-max-uses", description: "max_uses raised after signing", key_id: "approval-a", input: { ...grantInput, max_uses: 6 }, payload: grantPayload.replace("max_uses=5", "max_uses=6"), signature_b64u: b64u(signDer("approval-a", grantPayload)), expect_valid: false },
  { id: "grant-session-key", description: "signed by the session key, not the approval key", key_id: "approval-a", input: grantInput, payload: grantPayload, signature_b64u: b64u(signDer("session-a", grantPayload)), expect_valid: false },
];

const out = {
  vectors_version: 1,
  note: "Read-only contract. Append new vectors, never change existing ones. Format: contract/README.md. Keys are TEST ONLY.",
  signature_format: "ECDSA P-256, SHA-256, ASN.1 DER (not raw r||s), base64url without padding",
  keys: keys.map(({ id, note, spki_b64u }) => ({ id, note, spki_b64u })),
  canonical_query,
  canonical_query_errors,
  body_hash,
  envelope,
  challenge,
  grant,
};
writeFileSync(process.argv[2]!, JSON.stringify(out, null, 2) + "\n");
