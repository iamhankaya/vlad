import type { FastifyReply, FastifyRequest } from "fastify";
import type { DeviceRecord } from "../auth/devices.ts";
import { reject, type ApprovalGuard, type GuardVerdict } from "../http/approval.ts";
import { send } from "../http/errors.ts";
import { KINDS, ActionError, type ActionService } from "./service.ts";

const ID = /^[A-Za-z0-9_-]+$/;

function parseBody(req: FastifyRequest): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const verdictOf = (e: ActionError): GuardVerdict => reject(e.status, e.code, e.details);

function respond(reply: FastifyReply, e: unknown) {
  if (e instanceof ActionError) return send(reply, e.status, e.code, e.details);
  throw e;
}

/** `prepareAction` and `approveAction`; the app mounts them behind its signature check (and, for approve, the approval guard below). */
export function actionHandlers(svc: ActionService) {
  return {
    prepareAction: async (req: FastifyRequest, reply: FastifyReply) => {
      const b = parseBody(req);
      const bad = (field: string) => send(reply, 400, "bad_request", { field });
      if (!b || Object.keys(b).some((k) => !["kind", "task_id", "card_id", "params"].includes(k))) return send(reply, 400, "bad_request");
      if (typeof b.kind !== "string" || !(KINDS as readonly string[]).includes(b.kind)) return bad("kind");
      for (const k of ["task_id", "card_id"] as const) if (b[k] !== undefined && (typeof b[k] !== "string" || !ID.test(b[k] as string))) return bad(k);
      if (b.params !== undefined) {
        const p = b.params;
        if (!p || typeof p !== "object" || Array.isArray(p) || Object.values(p).some((v) => typeof v !== "string" || v.length > 200)) return bad("params");
      }
      try {
        return await svc.prepare(req.vladDevice!, b as { kind: string; task_id?: string; card_id?: string; params?: Record<string, string> });
      } catch (e) {
        return respond(reply, e);
      }
    },

    approveAction: async (req: FastifyRequest, reply: FastifyReply) => {
      const g = req.vladApproval;
      // The guard is mandatory: a request that did not pass it never gets here, and a missing context is a wiring bug, not a client error.
      if (!g || g.operationId !== "approveAction") return send(reply, 500, "bad_request", undefined, "Sunucu hatası.");
      try {
        return await svc.approve(g.device, (req.params as { id: string }).id, (g.data as { signature: string }).signature);
      } catch (e) {
        return respond(reply, e);
      }
    },
  };
}

/** Approval guard of `approveAction`: strict body, then everything that needs no GitHub (device, challenge, stored-bytes signature). */
export function approveGuard(svc: ActionService): ApprovalGuard {
  return (req, device: DeviceRecord) => {
    const b = parseBody(req);
    if (!b || Object.keys(b).some((k) => k !== "signature") || typeof b.signature !== "string") return reject(400, "bad_request");
    try {
      svc.inspect(device, (req.params as { id: string }).id, b.signature);
    } catch (e) {
      if (e instanceof ActionError) return verdictOf(e);
      throw e;
    }
    return { ok: true, data: { signature: b.signature } };
  };
}
