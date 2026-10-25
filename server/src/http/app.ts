import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { DeviceLedger, type DeviceRecord } from "../auth/devices.ts";
import { verifyEnvelope, verifyRevokeApproval } from "../auth/envelope.ts";
import { ensureDir } from "../auth/files.ts";
import { isP256Spki } from "../auth/keys.ts";
import { PairingCodes } from "../auth/pairing.ts";
import { RateLimiter } from "../auth/ratelimit.ts";
import { ReplayCache } from "../auth/replay.ts";
import { ROUTES, type RouteSpec } from "./routes.generated.ts";

export const BODY_LIMIT = 1024 * 1024;

export type AppConfig = {
  /** `vladapi` user's state directory (0700). */
  stateDir: string;
  version: string;
  now?: () => number;
  /** Trust `X-Forwarded-For` (set when running behind Tailscale Funnel); off by default so the socket address is the client. */
  trustProxy?: boolean;
  logger?: boolean;
  limits?: { unpaired?: [capacity: number, perSec: number]; paired?: [number, number]; public?: [number, number] };
};

declare module "fastify" {
  interface FastifyContextConfig {
    spec?: RouteSpec;
  }
  interface FastifyRequest {
    /** Set by the signature preHandler on every route that passed it. */
    vladDevice?: DeviceRecord;
  }
}

type ErrorCode = "unauthorized" | "device_revoked" | "bad_request" | "rate_limited";
const MESSAGES: Record<ErrorCode, string> = {
  unauthorized: "Yetkisiz.",
  device_revoked: "Cihaz iptal edildi.",
  bad_request: "Geçersiz istek.",
  rate_limited: "Çok fazla deneme.",
};

function send(reply: FastifyReply, status: number, code: ErrorCode, details?: Record<string, unknown>, message?: string) {
  return reply.code(status).type("application/json").send({ error: { code, message_tr: message ?? MESSAGES[code], ...(details ? { details } : {}) } });
}

const bodyBytes = (req: FastifyRequest): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

function jsonBody(req: FastifyRequest): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes(req)));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const hasOnly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

export function buildApp(cfg: AppConfig): FastifyInstance {
  const now = cfg.now ?? Date.now;
  ensureDir(cfg.stateDir);
  const devices = new DeviceLedger(cfg.stateDir);
  const replay = new ReplayCache(cfg.stateDir, now);
  const pairing = new PairingCodes(cfg.stateDir, now);
  // Separate buckets: unpaired traffic (pairing attempts, failed signatures) is tight and keyed by address;
  // a valid signature is charged to its (verified) device so one noisy phone cannot starve another, and an
  // attacker cannot drain a real device's bucket because only verified requests are charged to it.
  const [uCap, uRate] = cfg.limits?.unpaired ?? [10, 10 / 60];
  const [pCap, pRate] = cfg.limits?.paired ?? [60, 2];
  const [hCap, hRate] = cfg.limits?.public ?? [30, 1];
  const unpaired = new RateLimiter(now, uCap, uRate);
  const paired = new RateLimiter(now, pCap, pRate);
  const publicBucket = new RateLimiter(now, hCap, hRate);

  const app = Fastify({
    logger: cfg.logger ?? false,
    bodyLimit: BODY_LIMIT,
    trustProxy: cfg.trustProxy ?? false,
    exposeHeadRoutes: false,
  });

  // Every body is kept as raw bytes: the envelope hashes bytes, and nothing is parsed before the signature is checked.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body));

  const limited = (reply: FastifyReply, bucket: RateLimiter, key: string) =>
    send(reply, 429, "rate_limited", { retry_after_s: Math.max(1, bucket.retryAfterS(key)) });

  // No route reads a body on GET; reject one instead of hashing something other than what the client signed.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.raw.url?.startsWith("/")) return send(reply, 400, "bad_request");
    if (req.method === "GET" && (req.headers["transfer-encoding"] !== undefined || (req.headers["content-length"] ?? "0") !== "0")) return send(reply, 400, "bad_request");
  });

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const spec = req.routeOptions?.config?.spec;
    const url = req.raw.url!;
    const q = url.indexOf("?");
    const rawPath = q < 0 ? url : url.slice(0, q);
    // Public only when the raw path is exactly the route: `/v1/%68ealth/` or `//v1/health` are not "the" public route.
    if (spec?.auth === "none" && rawPath === spec.path) {
      if (spec.operationId === "getHealth" && !publicBucket.take(req.ip)) return limited(reply, publicBucket, req.ip);
      return;
    }
    const r = verifyEnvelope({ devices, replay, now }, { method: req.method, rawUrl: url, headers: req.headers, body: bodyBytes(req) });
    if (!r.ok) {
      req.log.debug({ reason: r.reason }, "auth rejected");
      if (r.code === "bad_request") return send(reply, 400, "bad_request");
      if (!unpaired.take(req.ip)) return limited(reply, unpaired, req.ip);
      return send(reply, 401, r.code);
    }
    if (!paired.take(r.device.device_id)) return limited(reply, paired, r.device.device_id);
    req.vladDevice = r.device;
  };

  type Handler = (req: FastifyRequest, reply: FastifyReply) => unknown;
  const handlers: Record<string, Handler> = {
    getHealth: () => ({ ok: true, version: cfg.version }),

    pairDevice: (req, reply) => {
      if (!unpaired.take(req.ip)) return limited(reply, unpaired, req.ip);
      const b = jsonBody(req);
      if (!b || !hasOnly(b, ["code", "device_name", "session_pub", "approval_pub", "fcm_token"])) return send(reply, 400, "bad_request");
      const { code, device_name: name, session_pub: sessionPub, approval_pub: approvalPub, fcm_token: fcm } = b;
      if (typeof code !== "string" || !/^[0-9A-Za-z]{8}$/.test(code)) return send(reply, 400, "bad_request", { field: "code" });
      if (typeof name !== "string" || name.length < 1 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) return send(reply, 400, "bad_request", { field: "device_name" });
      if (!isP256Spki(sessionPub)) return send(reply, 400, "bad_request", { field: "session_pub" });
      if (!isP256Spki(approvalPub)) return send(reply, 400, "bad_request", { field: "approval_pub" });
      if (fcm !== undefined && (typeof fcm !== "string" || fcm.length < 1 || fcm.length > 4096)) return send(reply, 400, "bad_request", { field: "fcm_token" });
      // One key must never serve both roles (a stolen session key would then also approve), nor be shared across devices.
      if (sessionPub === approvalPub || devices.hasKey(sessionPub) || devices.hasKey(approvalPub)) return send(reply, 400, "bad_request", { field: "keys" });
      if (!pairing.redeem(code)) return send(reply, 401, "unauthorized");
      const device_id = devices.allocateId(name);
      devices.add({ device_id, device_name: name, session_pub: sessionPub, approval_pub: approvalPub, ...(fcm ? { fcm_token: fcm } : {}), created: new Date(now()).toISOString() });
      return { device_id, server_time: now() };
    },

    revokeDevice: (req, reply) => {
      const caller = req.vladDevice!;
      const b = jsonBody(req);
      if (!b || !hasOnly(b, ["ts_ms", "signature"]) || !Number.isSafeInteger(b.ts_ms) || typeof b.signature !== "string") return send(reply, 400, "bad_request");
      const target = (req.params as { id: string }).id;
      const headerTs = Number(req.headers["x-vlad-ts"]); // already validated by the envelope check
      const why = verifyRevokeApproval({ replay }, caller, target, headerTs, b);
      if (why) {
        req.log.debug({ reason: why }, "revoke rejected");
        if (!unpaired.take(req.ip)) return limited(reply, unpaired, req.ip);
        return send(reply, 401, "unauthorized");
      }
      if (!devices.revoke(target, new Date(now()).toISOString())) return send(reply, 404, "bad_request", { reason: "not_found" }, "Kayıt yok.");
      return { ok: true };
    },
  };

  // Routes that are not implemented yet (S6c reads, S6d events, S9 actions...) still pass the signature preHandler first.
  const notImplemented: Handler = (_req, reply) => send(reply, 501, "bad_request", { reason: "not_implemented" }, "Henüz uygulanmadı.");

  for (const spec of ROUTES) {
    app.route({
      method: spec.method as "GET",
      url: spec.path,
      config: { spec },
      preHandler: authenticate,
      handler: async (req, reply) => (handlers[spec.operationId] ?? notImplemented)(req, reply),
    });
  }

  // Unknown paths are authenticated too: an unsigned probe learns nothing about which routes exist.
  app.setNotFoundHandler({ preHandler: authenticate }, (_req, reply) => send(reply, 404, "bad_request", { reason: "not_found" }, "Kayıt yok."));

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return send(reply, status, "bad_request", undefined, status === 413 ? "Gövde çok büyük." : undefined);
    req.log.error(err);
    return send(reply, 500, "bad_request", undefined, "Sunucu hatası.");
  });

  return app;
}
