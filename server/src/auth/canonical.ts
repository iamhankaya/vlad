import { createHash } from "node:crypto";

/**
 * Canonical request/challenge byte strings (pure). Single source of truth for the server (S6b), its tests and the
 * Android `:core` port (`Canonical.kt`); both sides are pinned by `contract/signing-vectors.json`
 * (format: `contract/README.md`). Nothing here verifies a signature.
 */

export class CanonicalError extends Error {
  readonly code: "bad_query" | "bad_envelope" | "bad_challenge";
  constructor(code: "bad_query" | "bad_envelope" | "bad_challenge", message: string) {
    super(message);
    this.code = code;
    this.name = "CanonicalError";
  }
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function percentDecode(s: string): string {
  const bytes: number[] = [];
  const raw = utf8.encode(s.replace(/\+/g, " "));
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x25) {
      const hex = String.fromCharCode(raw[i + 1] ?? 0, raw[i + 2] ?? 0);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new CanonicalError("bad_query", "geçersiz yüzde kodlaması");
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(raw[i]!);
    }
  }
  try {
    return strictUtf8.decode(Uint8Array.from(bytes));
  } catch {
    throw new CanonicalError("bad_query", "sorgu geçerli UTF-8 değil");
  }
}

function percentEncode(s: string): string {
  let out = "";
  for (const b of utf8.encode(s)) {
    const c = String.fromCharCode(b);
    out += b < 0x80 && UNRESERVED.test(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/**
 * Canonical query string (no leading `?`): split on `&` (empty segments dropped), key/value split at the first `=`
 * (no `=` means empty value), `+` and `%XX` decoded (UTF-8, strict), pairs sorted by key as UTF-8 bytes (a repeated
 * key, also after decoding, throws `bad_query`), then re-encoded with RFC 3986 unreserved characters only (space becomes `%20`).
 */
export function canonicalQuery(rawQuery: string): string {
  const q = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  const pairs: [string, string][] = [];
  for (const seg of q.split("&")) {
    if (seg === "") continue;
    const eq = seg.indexOf("=");
    pairs.push(eq < 0 ? [percentDecode(seg), ""] : [percentDecode(seg.slice(0, eq)), percentDecode(seg.slice(eq + 1))]);
  }
  const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  pairs.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  // No endpoint takes an array parameter, so a repeated key (also after decoding, `a` vs `%61`) is ambiguous input.
  for (let i = 1; i < pairs.length; i++) if (pairs[i]![0] === pairs[i - 1]![0]) throw new CanonicalError("bad_query", `yinelenen sorgu anahtarı: ${pairs[i]![0]}`);
  return pairs.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join("&");
}

export const sha256Hex = (body: Uint8Array | string): string => createHash("sha256").update(typeof body === "string" ? utf8.encode(body) : body).digest("hex");

export type EnvelopeInput = {
  method: string;
  /** Request path as sent (already encoded, no query). Signed verbatim, not decoded. */
  path: string;
  rawQuery?: string;
  tsMs: number;
  /** `X-Vlad-Nonce`: exactly 22 base64url characters (16 random bytes). */
  nonce: string;
  /** Raw request body bytes (empty body: `sha256("")`). The hash is over bytes, never over parsed JSON. */
  body?: Uint8Array;
};

const NONCE = /^[A-Za-z0-9_-]{22}$/;

/**
 * The server builds this from the raw request target (`req.raw.url`: raw path before `?`, as sent), before routing
 * or any normalization. `%2F`, `//` and a trailing `/` are therefore distinct signed paths.
 * `v1\n<METHOD>\n<path + ? + canonical query>\n<ts_ms>\n<nonce>\n<sha256hex(raw body)>` (no trailing newline). */
export function envelopeString(i: EnvelopeInput): string {
  if (!/^[A-Z]{3,7}$/.test(i.method)) throw new CanonicalError("bad_envelope", "yöntem büyük harfli olmalı");
  if (!/^\/[^?#\s\u0000-\u001f\u007f]*$/.test(i.path)) throw new CanonicalError("bad_envelope", "geçersiz yol");
  if (!Number.isSafeInteger(i.tsMs) || i.tsMs < 0) throw new CanonicalError("bad_envelope", "ts_ms negatif olmayan tam sayı olmalı");
  if (!NONCE.test(i.nonce)) throw new CanonicalError("bad_envelope", "nonce tam 22 karakter base64url olmalı (16 bayt)");
  const q = canonicalQuery(i.rawQuery ?? "");
  const target = q === "" ? i.path : `${i.path}?${q}`;
  return ["v1", i.method, target, String(i.tsMs), i.nonce, sha256Hex(i.body ?? new Uint8Array())].join("\n");
}

/** Challenge field order is fixed; `parseChallengeBytes` rejects any other order. */
export const CHALLENGE_FIELDS = ["action_id", "kind", "repo", "pr", "base", "head_sha", "task", "nonce", "exp"] as const;
export const CHALLENGE_HEADER = "vlad-approve/v1";
const VALUE = /^[A-Za-z0-9._/#:-]+$/;
export const FIELD_RULES: Record<(typeof CHALLENGE_FIELDS)[number], RegExp> = {
  action_id: /^A-[A-Za-z0-9_-]{1,64}$/,
  kind: /^[a-z_]{1,32}$/,
  repo: /^(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/, // no `.`/`..` segment: the repo ends up in a URL path
  pr: /^[1-9][0-9]{0,9}$/,
  base: /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/,
  head_sha: /^[0-9a-f]{40}$/,
  task: /^T[0-9]{8}-[0-9]{2,}$/,
  nonce: /^[A-Za-z0-9_-]{22}$/,
  exp: /^[1-9][0-9]{0,11}$/,
};

function checkChallengeField(k: (typeof CHALLENGE_FIELDS)[number], v: unknown): string {
  if (typeof v !== "string" || !VALUE.test(v) || !FIELD_RULES[k].test(v)) throw new CanonicalError("bad_challenge", `geçersiz challenge alanı: ${k}`);
  return v;
}

/** The exact bytes the `approval` key signs: `vlad-approve/v1` then `key=value` lines in fixed order, `\n`-joined, no trailing newline. */
export function challengeBytes(fields: Record<string, string>): Uint8Array {
  const extra = Object.keys(fields).filter((k) => !(CHALLENGE_FIELDS as readonly string[]).includes(k));
  if (extra.length) throw new CanonicalError("bad_challenge", `fazla challenge alanı: ${extra.join(",")}`);
  const lines = CHALLENGE_FIELDS.map((k) => {
    if (!Object.hasOwn(fields, k)) throw new CanonicalError("bad_challenge", `eksik challenge alanı: ${k}`);
    return `${k}=${checkChallengeField(k, fields[k])}`;
  });
  return utf8.encode([CHALLENGE_HEADER, ...lines].join("\n"));
}

/** Strict inverse of `challengeBytes`: wrong header, order, missing/extra field, or any off-alphabet byte throws. */
export function parseChallengeBytes(bytes: Uint8Array): Record<string, string> {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    throw new CanonicalError("bad_challenge", "challenge geçerli UTF-8 değil");
  }
  const lines = text.split("\n");
  if (lines.length !== CHALLENGE_FIELDS.length + 1 || lines[0] !== CHALLENGE_HEADER) throw new CanonicalError("bad_challenge", "challenge başlığı/satır sayısı geçersiz");
  const out: Record<string, string> = {};
  CHALLENGE_FIELDS.forEach((k, i) => {
    const line = lines[i + 1]!;
    if (!line.startsWith(`${k}=`)) throw new CanonicalError("bad_challenge", `alan sırası geçersiz: beklenen ${k}`);
    out[k] = checkChallengeField(k, line.slice(k.length + 1));
  });
  return out;
}

export const REVOKE_HEADER = "vlad-revoke/v1";
export const TAKEOVER_HEADER = "vlad-takeover/v1";
const DEVICE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Bytes the `approval` key signs to revoke a device: `vlad-revoke/v1\ndevice=<target>\nsigner=<calling device>\nts=<ts_ms>`
 * (no trailing newline). Server rules (S6b): `signer` == `X-Vlad-Device`, `ts` == `X-Vlad-Ts`, within +-120 s,
 * `(signer, ts)` single use.
 */
export function revokeBytes(f: { device: string; signer: string; tsMs: number }): Uint8Array {
  for (const k of ["device", "signer"] as const) if (!DEVICE_ID.test(f[k])) throw new CanonicalError("bad_envelope", `geçersiz cihaz kimliği: ${k}`);
  if (!Number.isSafeInteger(f.tsMs) || f.tsMs < 0) throw new CanonicalError("bad_envelope", "ts_ms negatif olmayan tam sayı olmalı");
  return utf8.encode([REVOKE_HEADER, `device=${f.device}`, `signer=${f.signer}`, `ts=${f.tsMs}`].join("\n"));
}

/**
 * Bytes the `approval` key signs to take over the active VLAD: `vlad-takeover/v1\nsigner=<calling device>\nts=<ts_ms>` (no trailing newline).
 * The takeover has no parameters, so there is nothing else to bind. Server rules: `signer` == `X-Vlad-Device`, `ts` == `X-Vlad-Ts`, within +-120 s,
 * `(signer, ts)` single use.
 */
export function takeoverBytes(f: { signer: string; tsMs: number }): Uint8Array {
  if (!DEVICE_ID.test(f.signer)) throw new CanonicalError("bad_envelope", "geçersiz cihaz kimliği: signer");
  if (!Number.isSafeInteger(f.tsMs) || f.tsMs < 0) throw new CanonicalError("bad_envelope", "ts_ms negatif olmayan tam sayı olmalı");
  return utf8.encode([TAKEOVER_HEADER, `signer=${f.signer}`, `ts=${f.tsMs}`].join("\n"));
}
