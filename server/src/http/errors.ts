import type { FastifyReply } from "fastify";

export type ErrorCode = "unauthorized" | "device_revoked" | "bad_request" | "rate_limited" | "expired" | "head_moved" | "ci_not_green" | "not_mergeable";

const MESSAGES: Record<ErrorCode, string> = {
  unauthorized: "Yetkisiz.",
  device_revoked: "Cihaz iptal edildi.",
  bad_request: "Geçersiz istek.",
  rate_limited: "Çok fazla deneme.",
  expired: "Challenge süresi doldu ya da geçersiz kılındı.",
  head_moved: "PR başı değişti; yeniden hazırlayın.",
  ci_not_green: "CI yeşil değil.",
  not_mergeable: "PR şu an merge edilemez.",
};

export function send(reply: FastifyReply, status: number, code: ErrorCode, details?: Record<string, unknown>, message?: string) {
  return reply.code(status).type("application/json").send({ error: { code, message_tr: message ?? MESSAGES[code], ...(details ? { details } : {}) } });
}
