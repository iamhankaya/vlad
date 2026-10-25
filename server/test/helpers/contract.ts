import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCanonicalSignature } from "../../src/auth/der.ts";

export const CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contract");
export const readJson = <T = any>(...p: string[]): T => JSON.parse(readFileSync(join(CONTRACT_DIR, ...p), "utf8"));

/** Verification direction only: strict minimal DER + low-S, ECDSA P-256 SHA-256. Any malformed key/signature is simply "invalid". */
export function verifyDer(spkiB64u: string, message: string | Uint8Array, sigB64u: string): boolean {
  try {
    if (!isCanonicalSignature(Buffer.from(sigB64u, "base64url"))) return false;
    const key = createPublicKey({ key: Buffer.from(spkiB64u, "base64url"), format: "der", type: "spki" });
    return verify("sha256", Buffer.from(message), { key, dsaEncoding: "der" }, Buffer.from(sigB64u, "base64url"));
  } catch {
    return false;
  }
}
