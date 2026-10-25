import type { FastifyReply, FastifyRequest } from "fastify";
import { TakeoverError, type TakeoverResult } from "../kbsync/takeover.ts";
import { send } from "./errors.ts";

export interface ActiveDeps {
  /** One takeover run (`createTakeover`); throws {@link TakeoverError}. */
  takeover: () => Promise<TakeoverResult>;
}

const STATUS = { kb_conflict: 409, takeover_in_progress: 409, kb_sync_unavailable: 503 } as const;

/** `POST /v1/active/takeover` (session+approval). The body is only the approval (`ts_ms`, `signature`); no input; what happens is decided by the kb and main, not by the caller. */
export function activeHandlers(deps: ActiveDeps): Record<string, (req: FastifyRequest, reply: FastifyReply) => unknown> {
  return {
    takeoverActive: async (req, reply) => {
      // the central approval guard (`takeoverGuard` in app.ts) has verified the `approval` signature; no guard verdict, no takeover
      if (req.vladApproval?.operationId !== "takeoverActive") return send(reply, 500, "bad_request", undefined, "Sunucu hatası.");
      try {
        const r = await deps.takeover();
        if (r.state === "active") return { ok: true, state: "active" };
        return reply.code(202).send({ ok: true, state: "pending", reason: r.reason });
      } catch (e) {
        if (e instanceof TakeoverError) return send(reply, STATUS[e.code], e.code, { reason: e.code });
        throw e;
      }
    },
  };
}
