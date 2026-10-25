// One-shot (review round 2, part 2): replaces env-unsorted-query-signs-canonical, whose raw query repeated a key (now an error),
// with a vector signed by a new test-only key. Kept for provenance; do NOT rerun.
// Usage: node scripts/extend-signing-vectors-2.ts <vectors.json>
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { encodeDer, P256_N, parseStrictDer } from "../src/auth/der.ts";
import { envelopeString } from "../src/auth/canonical.ts";

const file = process.argv[2]!;
const V = JSON.parse(readFileSync(file, "utf8"));
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
V.keys.push({ id: "session-c", note: "TEST ONLY: third device session key (query vector)", spki_b64u: publicKey.export({ type: "spki", format: "der" }).toString("base64url") });
const key = createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }));
const input = { method: "GET", path: "/v1/projects", raw_query: "b=2&a=1&c=%C3%BC", ts_ms: 1761350400000, nonce: "AAECAwQFBgcICQoLDA0ODw", body_b64u: "" };
const str = envelopeString({ method: input.method, path: input.path, rawQuery: input.raw_query, tsMs: input.ts_ms, nonce: input.nonce });
let sig = sign("sha256", Buffer.from(str), { key, dsaEncoding: "der" });
const p = parseStrictDer(sig)!;
if (p.s > P256_N >> 1n) sig = Buffer.from(encodeDer(p.r, P256_N - p.s));
V.envelope = V.envelope.filter((v: { id: string }) => v.id !== "env-unsorted-query-signs-canonical");
V.envelope.push({ id: "env-unsorted-query-signs-canonical", description: "client signs canonical query; raw order on the wire is irrelevant", key_id: "session-c", input, envelope_string: str, signature_b64u: sig.toString("base64url"), expect_valid: true });
writeFileSync(file, JSON.stringify(V, null, 2) + "\n");
