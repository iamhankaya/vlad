/**
 * Strict ECDSA P-256 DER signature checks (pure). Node/OpenSSL accept non-minimal DER and high-S signatures; the
 * contract does not: a signature is acceptable only if it is minimally encoded DER and `s <= n/2` (low-S).
 * Kotlin `:core` and the server must apply the same rule (vectors in `contract/signing-vectors.json`).
 */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const P256_HALF_N = P256_N >> 1n;

const toBig = (b: Uint8Array): bigint => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);

function readInt(b: Uint8Array, i: number): { v: bigint; next: number } | null {
  if (b[i] !== 0x02) return null;
  const len = b[i + 1];
  if (len === undefined || len < 1 || len >= 0x80 || i + 2 + len > b.length) return null;
  const body = b.subarray(i + 2, i + 2 + len);
  if (body[0]! & 0x80) return null; // negative
  if (len > 1 && body[0] === 0 && !(body[1]! & 0x80)) return null; // non-minimal leading zero
  return { v: toBig(body), next: i + 2 + len };
}

/** Minimal short-form DER SEQUENCE{INTEGER r, INTEGER s}; anything else (long form, padding, trailing bytes) is null. */
export function parseStrictDer(sig: Uint8Array): { r: bigint; s: bigint } | null {
  if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30 || sig[1]! >= 0x80 || sig[1] !== sig.length - 2) return null;
  const r = readInt(sig, 2);
  const s = r && readInt(sig, r.next);
  if (!r || !s || s.next !== sig.length) return null;
  if (r.v <= 0n || r.v >= P256_N || s.v <= 0n || s.v >= P256_N) return null;
  return { r: r.v, s: s.v };
}

/** True only for strictly encoded DER with low-S. */
export const isCanonicalSignature = (sig: Uint8Array): boolean => {
  const p = parseStrictDer(sig);
  return p !== null && p.s <= P256_HALF_N;
};

function encInt(v: bigint): number[] {
  const bytes: number[] = [];
  for (let x = v; x > 0n; x >>= 8n) bytes.unshift(Number(x & 0xffn));
  if (bytes.length === 0 || bytes[0]! & 0x80) bytes.unshift(0);
  return [0x02, bytes.length, ...bytes];
}

/** Minimal DER encoding of (r, s). */
export function encodeDer(r: bigint, s: bigint): Uint8Array {
  const body = [...encInt(r), ...encInt(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}
