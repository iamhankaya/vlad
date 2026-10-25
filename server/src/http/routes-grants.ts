import type { FastifyReply, FastifyRequest } from "fastify";
import { GrantEngine, GrantRefusal, GrantStore, parseGrantRequest, signatureHolds, type GrantConfig } from "../actions/grants.ts";
import type { ActionService, ProjectSource, TaskSource } from "../actions/service.ts";
import type { DeviceLedger } from "../auth/devices.ts";
import type { EventLedger } from "../events/ledger.ts";
import { reject, type ApprovalGuard } from "./approval.ts";
import { send } from "./errors.ts";

type Handler = (req: FastifyRequest, reply: FastifyReply) => unknown;

export type GrantRoutes = { handlers: Record<string, Handler>; guards: Record<string, ApprovalGuard>; engine?: GrantEngine; stop: () => void };

const GRANT_ID = /^G-([0-9]{3}|[1-9][0-9]{3,})$/;

function jsonBody(req: FastifyRequest): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
  } catch {
    return undefined;
  }
}

/**
 * `listGrants`, `createGrant` (session + approval) and `revokeGrant` (S10a), plus the engine that carries out gate cards a grant covers
 * (it listens for `task.state: awaiting_approval` on the ledger). Without the approval path (`actions`) there is nothing a grant could do, so
 * none of it is wired and the three routes stay "not implemented".
 */
export function registerGrantRoutes(d: {
  config?: GrantConfig;
  actions?: ActionService;
  source?: { tasks: TaskSource; projects: ProjectSource };
  devices: DeviceLedger;
  ledger: EventLedger;
  stateDir: string;
  now: () => number;
}): GrantRoutes {
  if (!d.actions || !d.source) return { handlers: {}, guards: {}, stop: () => {} };
  const engine = new GrantEngine({ store: new GrantStore(d.stateDir), devices: d.devices, svc: d.actions, tasks: d.source.tasks, projects: d.source.projects, now: d.now, config: d.config });
  d.ledger.onAppend((e) => {
    if (e.type === "task.state" && e.data.state === "awaiting_approval" && typeof e.data.task_id === "string") engine.onTaskAwaiting(e.data.task_id);
  });
  const stop = engine.start();

  const refuse = (reply: FastifyReply, e: unknown) => {
    if (e instanceof GrantRefusal) return send(reply, e.status, e.code, e.details);
    throw e;
  };

  const createGuard: ApprovalGuard = (req, caller) => {
    let grant;
    try {
      grant = parseGrantRequest(jsonBody(req), d.now());
    } catch (e) {
      if (e instanceof GrantRefusal) return reject(e.status, e.code, e.details);
      throw e;
    }
    const dev = d.devices.get(caller.device_id);
    if (!dev || dev.revoked_at) return reject(401, "device_revoked");
    // Signed with the `approval` key of the calling device, over exactly these fields. Failures are charged to the address bucket.
    if (!signatureHolds(grant, dev)) return reject(422, "grant_invalid", { reason: "bad_signature" }, { charge: true });
    return { ok: true, data: { grant } };
  };

  return {
    engine,
    stop,
    guards: { createGrant: createGuard },
    handlers: {
      listGrants: async (_req, reply) => {
        try {
          return await engine.list();
        } catch {
          return send(reply, 503, "bad_request", { reason: "kb_unavailable" });
        }
      },
      // The signature was verified by the guard (`createGuard`), the device comes from the verified envelope, never from the body.
      createGrant: async (req, reply) => {
        const a = req.vladApproval;
        if (!a || a.operationId !== "createGrant") return send(reply, 500, "bad_request", undefined, "Sunucu hatası.");
        try {
          return await engine.create(a.device.device_id, (a.data as { grant: Parameters<GrantEngine["create"]>[1] }).grant);
        } catch (e) {
          return refuse(reply, e);
        }
      },
      revokeGrant: async (req, reply) => {
        const id = (req.params as { id: string }).id;
        if (!GRANT_ID.test(id)) return send(reply, 400, "bad_request", { field: "id" });
        if (!(await engine.revoke(id))) return send(reply, 404, "bad_request", { reason: "not_found" }, "Kayıt yok.");
        return { ok: true };
      },
    },
  };
}
