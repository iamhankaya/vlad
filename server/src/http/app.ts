import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { actionHandlers, approveGuard } from "../actions/routes.ts";
import { ActionService, type ActionPolicy, type ExecuteAction, type ProjectSource, type TaskSource } from "../actions/service.ts";
import { ActionStore } from "../actions/state.ts";
import type { GithubReader } from "../actions/github.ts";
import { DeviceLedger, type DeviceRecord } from "../auth/devices.ts";
import { verifyEnvelope, verifyRevokeApproval } from "../auth/envelope.ts";
import { ensureDir } from "../auth/files.ts";
import { isP256Spki } from "../auth/keys.ts";
import { PairingCodes } from "../auth/pairing.ts";
import { RateLimiter } from "../auth/ratelimit.ts";
import { ReplayCache } from "../auth/replay.ts";
import { EventLedger } from "../events/ledger.ts";
import { SseHub, type HubDeps } from "../events/hub.ts";
import { eventHandlers } from "../events/routes.ts";
import { ReadCache } from "../read/cache.ts";
import { readHandlers, type ReadDeps } from "../read/routes.ts";
import { registerGrantRoutes } from "./routes-grants.ts";
import type { GrantConfig, GrantEngine } from "../actions/grants.ts";
import { chatHandlers, type ChatDeps } from "./routes-chat.ts";
import { reject, type ApprovalContext, type ApprovalGuard } from "./approval.ts";
import { send } from "./errors.ts";
import { ROUTES, type RouteSpec } from "./routes.generated.ts";
import { join } from "node:path";

export const BODY_LIMIT = 1024 * 1024;

export type AppConfig = {
  /** `vladapi` user's state directory (0700). */
  stateDir: string;
  version: string;
  now?: () => number;
  /**
   * Fastify `trustProxy`. Off by default (the socket address is the client). Behind Tailscale Funnel use `"loopback"`: only the
   * local proxy is trusted, so `req.ip` is the rightmost `X-Forwarded-For` entry the proxy appended, never the client-written leftmost one.
   */
  trustProxy?: boolean | string;
  logger?: boolean;
  /** Read endpoints (S6c): event seq, gate provider, cache. */
  read?: ReadDeps;
  /** Event ledger and SSE (S6d). Defaults: ledger in `stateDir`, 64 streams (3 per device), `setInterval` keepalive. */
  events?: { ledger?: EventLedger; maxStreams?: number; maxPerDevice?: number; every?: HubDeps["every"] };
  /** Extra revocation listener (S9a: pending challenges, S10a: grants). Runs after the device's SSE streams are closed. */
  onRevoke?: (deviceId: string) => void;
  /**
   * Approval path (S9a): live GitHub reads, task facts, the single exit `execute` (S9b). Without it `prepareAction` and
   * `approveAction` stay "not implemented" (they still pass the signature check first).
   */
  actions?: { reader: GithubReader; tasks: TaskSource; projects: ProjectSource; execute: ExecuteAction; /** Default `<stateDir>/challenges`. */ dir?: string; sleep?: (ms: number) => Promise<void>; policy?: ActionPolicy };
  /** Grant engine (S10a): kb mirror, live checks, sweep. Only active together with `actions`. */
  grants?: GrantConfig;
  /** Chat, card answers, change requests (S11b). Without it those routes answer 501; without `runner` only the chat routes do. */
  chat?: ChatDeps;
  /** Handlers of later slices (and tests) by `operationId`. A `session+approval` route with a handler here needs a guard in `approvalGuards`. */
  extraHandlers?: Record<string, (req: FastifyRequest, reply: FastifyReply) => unknown>;
  /** Approval guards by `operationId` (see `http/approval.ts`). */
  approvalGuards?: Record<string, ApprovalGuard>;
  limits?: { unpaired?: [capacity: number, perSec: number]; paired?: [number, number]; public?: [number, number] };
};

declare module "fastify" {
  interface FastifyInstance {
    /** Event ledger and stream hub: other slices append events (`vladEvents.ledger.append`); main starts the kb watcher on it. */
    vladEvents: { ledger: EventLedger; hub: SseHub; cache: ReadCache };
    /** Approval path service when `AppConfig.actions` is set. */
    vladActions?: ActionService;
    /** Grant engine when `AppConfig.actions` is set (S10a). */
    vladGrants?: GrantEngine;
    /** `operationId`s that have an approval guard (route inventory test). */
    vladApprovalGuards: ReadonlySet<string>;
  }
  interface FastifyContextConfig {
    spec?: RouteSpec;
  }
  interface FastifyRequest {
    /** Set by the signature preHandler on every route that passed it. */
    vladDevice?: DeviceRecord;
    /** Set by the central approval guard on `session+approval` routes; handlers read it, they never verify approvals themselves. */
    vladApproval?: ApprovalContext;
  }
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

  const ledger = cfg.events?.ledger ?? new EventLedger(cfg.stateDir);
  const cache = cfg.read?.cache ?? new ReadCache();
  // A new event means the kb changed: drop the 2 s read cache first, so a client reacting to the event never reads older data.
  ledger.onAppend(() => cache.clear());
  const hub = new SseHub({
    ledger,
    isActive: (id) => {
      const d = devices.get(id);
      return !!d && !d.revoked_at;
    },
    every: cfg.events?.every ?? ((ms, fn) => {
      const t = setInterval(fn, ms);
      t.unref();
      return () => clearInterval(t);
    }),
    maxStreams: cfg.events?.maxStreams,
    maxPerDevice: cfg.events?.maxPerDevice,
  });
  // Revocation closes the device's open streams before anything else reacts to it.
  devices.onRevoke((id) => hub.closeDevice(id));
  const onClose: (() => void)[] = [];
  const actions = cfg.actions
    ? new ActionService({
        store: new ActionStore(cfg.actions.dir ?? join(cfg.stateDir, "challenges")),
        devices, reader: cfg.actions.reader, tasks: cfg.actions.tasks, projects: cfg.actions.projects, execute: cfg.actions.execute, now, sleep: cfg.actions.sleep, policy: cfg.actions.policy,
      })
    : undefined;
  // A revoked device's pending challenges die with it (before any external listener runs).
  if (actions) {
    devices.onRevoke((id) => actions.onDeviceRevoked(id));
    const t = setInterval(() => actions.prune(), 10 * 60_000);
    t.unref();
    onClose.push(() => clearInterval(t));
  }
  if (cfg.onRevoke) devices.onRevoke(cfg.onRevoke);
  const grants = registerGrantRoutes({ config: cfg.grants, actions, source: cfg.actions, devices, ledger, stateDir: cfg.stateDir, now });
  onClose.push(grants.stop);

  const app = Fastify({
    logger: cfg.logger ?? false,
    bodyLimit: BODY_LIMIT,
    trustProxy: cfg.trustProxy ?? false,
    exposeHeadRoutes: false,
  });

  // Every body is kept as raw bytes: the envelope hashes bytes, and nothing is parsed before the signature is checked.
  app.decorate("vladEvents", { ledger, hub, cache });
  app.decorate("vladActions", actions);
  app.decorate("vladGrants", grants.engine);
  app.addHook("onClose", async () => {
    hub.closeAll();
    for (const f of onClose) f();
  });
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
    ...readHandlers({ ...cfg.read, warnings: () => [...(cfg.read?.warnings?.() ?? []), ...(cfg.chat?.runner?.warnings() ?? [])], cache, seq: cfg.read?.seq ?? (() => ledger.lastSeq) }),
    ...eventHandlers(ledger, hub),
    ...(actions ? actionHandlers(actions) : {}),
    ...grants.handlers,
    ...(cfg.chat ? chatHandlers(cfg.chat) : {}),
    ...cfg.extraHandlers,
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

    // The approval was verified by the central guard (`revokeGuard`); this only acts on it.
    revokeDevice: (req, reply) => {
      if (req.vladApproval?.operationId !== "revokeDevice") return send(reply, 500, "bad_request", undefined, "Sunucu hatası.");
      if (!devices.revoke((req.params as { id: string }).id, new Date(now()).toISOString())) return send(reply, 404, "bad_request", { reason: "not_found" }, "Kayıt yok.");
      return { ok: true };
    },
  };

  /** The `approval` signature of a device revocation (`vlad-revoke/v1`), see `verifyRevokeApproval`. Failures are charged to the address bucket. */
  const revokeGuard: ApprovalGuard = (req, caller) => {
    const b = jsonBody(req);
    if (!b || !hasOnly(b, ["ts_ms", "signature"]) || !Number.isSafeInteger(b.ts_ms) || typeof b.signature !== "string") return reject(400, "bad_request");
    const headerTs = Number(req.headers["x-vlad-ts"]); // already validated by the envelope check
    const why = verifyRevokeApproval({ replay }, caller, (req.params as { id: string }).id, headerTs, b);
    if (why) {
      req.log.debug({ reason: why }, "revoke rejected");
      return reject(401, "unauthorized", undefined, { charge: true });
    }
    return { ok: true };
  };
  // Built-in guards come last: nothing passed in can replace the guard of `revokeDevice` or `approveAction`.
  const guards: Record<string, ApprovalGuard> = { ...cfg.approvalGuards, revokeDevice: revokeGuard, ...(actions ? { approveAction: approveGuard(actions) } : {}), ...grants.guards };

  app.decorate("vladApprovalGuards", new Set(Object.keys(guards)));

  // Fail closed at startup: a `session+approval` route that has a handler must have a guard, or it could be reached without an approval.
  for (const spec of ROUTES) if (spec.auth === "session+approval" && handlers[spec.operationId] && !guards[spec.operationId]) throw new Error(`approval guard eksik: ${spec.operationId}`);

  const approvalPreHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const spec = req.routeOptions.config.spec!;
    const guard = guards[spec.operationId];
    if (!guard) return send(reply, 501, "bad_request", { reason: "not_implemented" }, "Henüz uygulanmadı."); // fail closed: never fall through to a handler
    const verdict = await guard(req, req.vladDevice!);
    if (!verdict.ok) {
      if (verdict.charge && !unpaired.take(req.ip)) return limited(reply, unpaired, req.ip);
      return send(reply, verdict.status, verdict.code, verdict.details, verdict.message);
    }
    req.vladApproval = { operationId: spec.operationId, device: req.vladDevice!, data: verdict.data };
  };

  // Routes that are not implemented yet (S6d events, S9 actions...) still pass the signature preHandler first.
  const notImplemented: Handler = (_req, reply) => send(reply, 501, "bad_request", { reason: "not_implemented" }, "Henüz uygulanmadı.");

  for (const spec of ROUTES) {
    app.route({
      method: spec.method as "GET",
      url: spec.path,
      config: { spec },
      preHandler: spec.auth === "session+approval" ? [authenticate, approvalPreHandler] : authenticate,
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
