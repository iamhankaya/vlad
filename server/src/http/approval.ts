import type { FastifyRequest } from "fastify";
import type { DeviceRecord } from "../auth/devices.ts";
import type { ErrorCode } from "./errors.ts";

/**
 * Central approval enforcement (finding F-vlad-016). A route whose contract auth is `session+approval` never runs its
 * handler before the guard registered for its `operationId` has said yes; `buildApp` refuses to start when such a route has
 * a handler but no guard. A guard returns a verdict; the handler only ever sees `req.vladApproval`.
 */
export type GuardVerdict =
  | { ok: true; data?: unknown }
  | { ok: false; status: number; code: ErrorCode; details?: Record<string, unknown>; message?: string; /** Also charge the failure to the caller's address bucket. */ charge?: boolean };

export type ApprovalGuard = (req: FastifyRequest, device: DeviceRecord) => GuardVerdict | Promise<GuardVerdict>;

export type ApprovalContext = { operationId: string; device: DeviceRecord; data?: unknown };

export const reject = (status: number, code: ErrorCode, details?: Record<string, unknown>, extra: { charge?: boolean } = {}): GuardVerdict => ({ ok: false, status, code, ...(details ? { details } : {}), ...extra });
