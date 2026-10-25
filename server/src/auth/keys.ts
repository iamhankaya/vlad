import { createPublicKey, verify } from "node:crypto";
import { isCanonicalSignature } from "./der.ts";

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Strict base64url (no padding, canonical trailing bits): decode then re-encode must give the input back. */
export function decodeB64url(s: unknown, maxChars: number): Buffer | null {
  if (typeof s !== "string" || s.length === 0 || s.length > maxChars || !B64URL.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.toString("base64url") === s ? b : null;
}

/** True only for a canonical SPKI DER P-256 public key (what Android Keystore exports). */
export function isP256Spki(b64u: unknown): b64u is string {
  const der = decodeB64url(b64u, 122);
  if (!der || der.length !== 91) return false;
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false;
    return Buffer.from(key.export({ format: "der", type: "spki" })).equals(der);
  } catch {
    return false;
  }
}

/** ECDSA P-256 / SHA-256 over strict minimal DER with low-S. Any malformed input is simply "false". */
export function verifySignature(spkiB64u: string, message: Uint8Array, sigB64u: unknown): boolean {
  try {
    const sig = decodeB64url(sigB64u, 100);
    if (!sig || !isCanonicalSignature(sig)) return false;
    const key = createPublicKey({ key: Buffer.from(spkiB64u, "base64url"), format: "der", type: "spki" });
    return verify("sha256", message, { key, dsaEncoding: "der" }, sig);
  } catch {
    return false;
  }
}
