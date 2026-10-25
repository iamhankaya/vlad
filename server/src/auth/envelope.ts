import type { IncomingHttpHeaders } from "node:http";
import { CanonicalError, canonicalQuery, envelopeString, revokeBytes } from "./canonical.ts";
import type { DeviceLedger, DeviceRecord } from "./devices.ts";
import { verifySignature } from "./keys.ts";
import type { ReplayCache } from "./replay.ts";

export const TS_WINDOW_MS = 120_000;

export type EnvelopeRequest = {
  method: string;
  /** `req.raw.url` as received: raw path and query, before routing and any normalization. */
  rawUrl: string;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
};

export type EnvelopeResult =
  | { ok: true; device: DeviceRecord; tsMs: number }
  /**
   * `bad_request` only for a malformed query (says nothing about who is asking); everything else about identity is
   * `unauthorized` / `device_revoked` and the HTTP body never reveals `reason` (it is for logs and tests).
   */
  | { ok: false; code: "bad_request" | "unauthorized" | "device_revoked"; reason: string };

const fail = (code: "bad_request" | "unauthorized" | "device_revoked", reason: string): EnvelopeResult => ({ ok: false, code, reason });
const single = (h: string | string[] | undefined): string | undefined => (typeof h === "string" ? h : undefined);

/**
 * Verifies the request envelope (`contract/README.md`): header syntax, +-120 s window, known device, `session`
 * signature over the bytes built from the raw request target and raw body, and finally the single-use nonce.
 * The nonce is stored only after the signature is valid, and a revoked device's valid signature does not consume one.
 */
export function verifyEnvelope(deps: { devices: DeviceLedger; replay: ReplayCache; now: () => number }, req: EnvelopeRequest): EnvelopeResult {
  if (!req.rawUrl.startsWith("/")) return fail("unauthorized", "target_not_origin_form");
  const q = req.rawUrl.indexOf("?");
  const path = q < 0 ? req.rawUrl : req.rawUrl.slice(0, q);
  const rawQuery = q < 0 ? "" : req.rawUrl.slice(q + 1);

  let query: string;
  try {
    query = canonicalQuery(rawQuery);
  } catch (e) {
    if (e instanceof CanonicalError) return fail("bad_request", "bad_query");
    throw e;
  }

  const deviceId = single(req.headers["x-vlad-device"]);
  const tsRaw = single(req.headers["x-vlad-ts"]);
  const nonce = single(req.headers["x-vlad-nonce"]);
  const sig = single(req.headers["x-vlad-sig"]);
  if (!deviceId || !tsRaw || !nonce || !sig) return fail("unauthorized", "missing_header");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId) || !/^(0|[1-9][0-9]{0,14})$/.test(tsRaw)) return fail("unauthorized", "bad_header");
  const tsMs = Number(tsRaw);
  if (Math.abs(deps.now() - tsMs) > TS_WINDOW_MS) return fail("unauthorized", "ts_window");

  const device = deps.devices.get(deviceId);
  if (!device) return fail("unauthorized", "unknown_device");

  let msg: string;
  try {
    msg = envelopeString({ method: req.method, path, rawQuery: query, tsMs, nonce, body: req.body });
  } catch (e) {
    if (e instanceof CanonicalError) return fail("unauthorized", "bad_envelope");
    throw e;
  }
  if (!verifySignature(device.session_pub, Buffer.from(msg), sig)) return fail("unauthorized", "bad_signature");
  if (device.revoked_at) return fail("device_revoked", "revoked");
  if (!deps.replay.claim(`n:${deviceId}:${nonce}`)) return fail("unauthorized", "nonce_replay");
  return { ok: true, device, tsMs };
}

/**
 * The `approval` signature of a device revocation: `vlad-revoke/v1` bytes with `signer = X-Vlad-Device` (the already
 * verified caller) and `ts = X-Vlad-Ts`, `ts_ms` in the body equal to the header, `(signer, ts)` single use.
 * Returns null when valid, otherwise the internal reason (the HTTP answer is always `401 unauthorized`).
 */
export function verifyRevokeApproval(
  deps: { replay: ReplayCache },
  caller: DeviceRecord,
  target: string,
  headerTsMs: number,
  body: { ts_ms?: unknown; signature?: unknown },
): string | null {
  if (body.ts_ms !== headerTsMs) return "ts_mismatch";
  let bytes: Uint8Array;
  try {
    bytes = revokeBytes({ device: target, signer: caller.device_id, tsMs: headerTsMs });
  } catch {
    return "bad_revoke_fields";
  }
  if (!verifySignature(caller.approval_pub, bytes, body.signature)) return "bad_approval_signature";
  if (!deps.replay.claim(`r:${caller.device_id}:${headerTsMs}`)) return "revoke_replay";
  return null;
}
