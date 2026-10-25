import type { FastifyReply, FastifyRequest } from "fastify";
import type { EventLedger } from "./ledger.ts";
import type { SseHub } from "./hub.ts";

const err = (reply: FastifyReply, status: number, code: string, message_tr: string, details?: object) =>
  reply.code(status).type("application/json").send({ error: { code, message_tr, ...(details ? { details } : {}) } });

const UINT = /^[0-9]{1,16}$/;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

/** Parsed query: only `after` (0..2^53-1) and `limit` (1..500) exist; anything else, a repeat or a malformed value is rejected. */
function query(raw: string): Map<string, string> | null {
  const out = new Map<string, string>();
  if (raw === "") return out;
  for (const part of raw.split("&")) {
    const i = part.indexOf("=");
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? "" : part.slice(i + 1);
    if (out.has(k)) return null;
    out.set(k, v);
  }
  return out;
}

export type EventHandler = (req: FastifyRequest, reply: FastifyReply) => unknown;

/** Handlers by `operationId`; the app mounts them behind its signature preHandler. */
export function eventHandlers(ledger: EventLedger, hub: SseHub): Record<"listEvents" | "streamEvents", EventHandler> {
  const rawQuery = (req: FastifyRequest) => {
    const u = req.raw.url ?? "";
    const q = u.indexOf("?");
    return q < 0 ? "" : u.slice(q + 1);
  };
  const bad = (reply: FastifyReply, field: string) => err(reply, 400, "bad_request", "Geçersiz istek.", { field });

  const listEvents: EventHandler = (req, reply) => {
    const q = query(rawQuery(req));
    if (!q) return bad(reply, "query");
    for (const k of q.keys()) if (k !== "after" && k !== "limit") return bad(reply, k);
    let after = 0;
    if (q.has("after")) {
      const v = q.get("after")!;
      if (!UINT.test(v) || !Number.isSafeInteger(Number(v))) return bad(reply, "after");
      after = Number(v);
    }
    let limit = DEFAULT_LIMIT;
    if (q.has("limit")) {
      const v = q.get("limit")!;
      limit = Number(v);
      if (!/^[0-9]{1,3}$/.test(v) || limit < 1 || limit > MAX_LIMIT) return bad(reply, "limit");
    }
    return { events: ledger.after(after, limit), last_seq: ledger.lastSeq };
  };

  const streamEvents: EventHandler = (req, reply) => {
    if (rawQuery(req) !== "") return bad(reply, "query");
    const h = req.headers["last-event-id"];
    let last: number | null = null;
    if (h !== undefined) {
      if (typeof h !== "string" || !UINT.test(h) || !Number.isSafeInteger(Number(h))) return bad(reply, "Last-Event-ID");
      last = Number(h);
    }
    const res = reply.raw;
    let stream: { close(): void } | null = null;
    res.on("close", () => stream?.close()); // bound before `open`, so a socket that dies during admission is not missed
    // The sink is the raw response; headers go out with the first write inside `open`, after admission.
    const admitted = hub.open(req.vladDevice!.device_id, {
      write: (c) => res.write(c),
      end: () => res.end(),
      get writableLength() { return res.writableLength; },
    }, last, () => {
      reply.hijack();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    });
    if (!admitted.ok) return err(reply, 429, "rate_limited", "Çok fazla açık bağlantı.", { retry_after_s: 5 });
    stream = admitted.stream;
    if (res.destroyed) stream.close();
    return reply;
  };

  return { listEvents, streamEvents };
}
