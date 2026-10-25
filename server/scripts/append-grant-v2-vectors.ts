// One-shot appender for ../contract/signing-vectors.json: the v2 grant vectors (project and repo are signed). Existing vectors stay untouched
// (the file is read-only contract); new TEST ONLY keys are appended, their private halves are discarded.
// Usage: node scripts/append-grant-v2-vectors.ts ../contract/signing-vectors.json
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { encodeDer, P256_N } from "../src/auth/der.ts";
import { grantSigningPayload } from "../src/actions/grants.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: append-grant-v2-vectors.ts <signing-vectors.json>");
const doc = JSON.parse(readFileSync(file, "utf8"));
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const mk = (id: string, note: string) => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { id, note, spki_b64u: b64u(publicKey.export({ type: "spki", format: "der" })), priv: privateKey };
};
const approval = mk("approval-g2", "TEST ONLY: device approval key (grant v2 vectors)");
const session = mk("session-g2", "TEST ONLY: device session key (grant v2 vectors)");
const signLow = (k: ReturnType<typeof mk>, msg: string) => {
  const raw = sign("sha256", Buffer.from(msg), { key: k.priv, dsaEncoding: "ieee-p1363" });
  const r = BigInt("0x" + raw.subarray(0, 32).toString("hex"));
  let s = BigInt("0x" + raw.subarray(32).toString("hex"));
  if (s > P256_N >> 1n) s = P256_N - s;
  return b64u(encodeDer(r, s));
};
const input = {
  id: "G-001", scope: { type: "project" as const, ref: "vlad" }, project: "vlad", repo: "iamhankaya/vlad", action: "merge_phase",
  conditions: ["no_severe_findings", "ci_green"], created: "2026-10-25T12:00:00Z", expires: "2026-11-24T12:00:00Z", max_uses: 5, payload_version: "v2" as const,
};
const payload = grantSigningPayload(input);
const vec = (id: string, description: string, over: Record<string, unknown>, signer: ReturnType<typeof mk>, expect_valid: boolean) => {
  const inp = { ...input, ...over };
  return { id, description, key_id: "approval-g2", input: inp, payload: grantSigningPayload(inp), signature_b64u: signLow(signer, payload), expect_valid };
};
doc.keys.push({ id: approval.id, note: approval.note, spki_b64u: approval.spki_b64u }, { id: session.id, note: session.note, spki_b64u: session.spki_b64u });
doc.grant.push(
  { id: "grant-v2-valid", description: "v2: approval key signs project and repo too", key_id: "approval-g2", input, payload, signature_b64u: signLow(approval, payload), expect_valid: true },
  vec("grant-v2-tampered-repo", "repo changed after signing", { repo: "iamhankaya/other" }, approval, false),
  vec("grant-v2-tampered-project", "project changed after signing", { project: "other" }, approval, false),
  vec("grant-v2-session-key", "signed by the session key, not the approval key", {}, session, false),
);
writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
