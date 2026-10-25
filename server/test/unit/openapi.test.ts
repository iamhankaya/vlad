import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACT_DIR } from "../helpers/contract.ts";
import { doc, operations } from "../helpers/openapi.ts";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// plan "Arayüzler" API table: operation -> imza
const PLAN: Record<string, "none" | "session" | "session+approval"> = {
  "GET /health": "none", "POST /pair": "none",
  "GET /home": "session", "GET /cards/{id}": "session", "GET /tasks/{id}": "session", "GET /pipelines": "session",
  "GET /projects": "session", "GET /projects/{slug}": "session", "GET /findings": "session",
  "GET /vault/search": "session", "GET /vault/file": "session",
  "POST /cards/{id}/answer": "session", "POST /tasks/{id}/request-changes": "session",
  "POST /chat": "session", "GET /chat/history": "session",
  "POST /actions/prepare": "session", "POST /actions/{id}/approve": "session+approval", "POST /actions/{id}/reject": "session",
  "GET /grants": "session", "DELETE /grants/{id}": "session", "POST /grants": "session+approval",
  "POST /active/takeover": "session",
  "GET /devices": "session", "PUT /devices/me/fcm": "session", "POST /devices/{id}/revoke": "session+approval",
  "GET /events": "session", "GET /stream": "session",
};

describe("server: openapi lint", () => {
  it("redocly lint passes without problems", () => {
    // --max-problems=0 makes warnings fail too; redocly prints its report on stderr
    const r = spawnSync("npx", ["--no-install", "redocly", "lint", join(CONTRACT_DIR, "openapi.yaml"), "--max-problems=0"], { cwd: serverDir, encoding: "utf8", timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/valid/);
  }, 130_000);
});

describe("server: openapi matches the plan", () => {
  it("lists exactly the planned operations with the planned signature class", () => {
    const got = Object.fromEntries(operations.map((o) => [`${o.method} ${o.path}`, o.op["x-vlad-auth"]]));
    expect(got).toEqual(PLAN);
  });
  it("security: [] exactly on unsigned operations; operationIds are unique", () => {
    for (const o of operations) expect(Array.isArray(o.op.security) && o.op.security.length === 0, o.id).toBe(o.op["x-vlad-auth"] === "none");
    expect(new Set(operations.map((o) => o.id)).size).toBe(operations.length);
  });
  it("base path /v1 and error envelope", () => {
    expect(doc.servers[0].url).toBe("/v1");
    const e = doc.components.schemas.Error;
    expect(e.required).toEqual(["error"]);
    expect(e.properties.error.required).toEqual(["code", "message_tr"]);
  });
  it("error codes and SSE types are the planned sets", () => {
    expect(doc.components.schemas.ErrorCode.enum).toEqual(["unauthorized", "expired", "head_moved", "ci_not_green", "not_mergeable", "not_delegable", "grant_invalid", "device_revoked", "bad_request", "rate_limited", "quota_hold", "active_elsewhere"]);
    expect(doc.components.schemas.EventType.enum).toEqual(["card.opened", "task.state", "worker.progress", "chat.delta", "chat.done", "action.executed", "grant.used", "quota.changed"]);
  });
  it("grants: only merge_phase|merge_final are delegable; non-delegable actions are outside every enum used by grants", () => {
    expect(doc.components.schemas.GrantAction.enum).toEqual(["merge_phase", "merge_final"]);
    expect(doc.components.schemas.GrantCreateRequest.properties.action).toEqual({ $ref: "#/components/schemas/GrantAction" });
    expect(doc.components.schemas.Grant.properties.action).toEqual({ $ref: "#/components/schemas/GrantAction" });
    const NON = ["tag_release", "publish", "delete", "security", "scope_change"];
    expect(doc.components.schemas.GrantAction.enum.filter((a: string) => NON.includes(a))).toEqual([]);
    expect(doc.components.schemas.ActionKind.enum).toContain("tag_release"); // device-approvable, never delegable
  });
  it("approve/revoke bodies carry no device id (X-Vlad-Device is the single source)", () => {
    const S = doc.components.schemas;
    expect(S.ApproveRequest.required).toEqual(["signature"]);
    expect(Object.keys(S.ApproveRequest.properties)).toEqual(["signature"]);
    expect(Object.keys(S.RevokeDeviceRequest.properties)).toEqual(["ts_ms", "signature"]);
    expect(S.RevokeDeviceRequest.description).toContain("X-Vlad-Ts");
  });
  it("body size, chat and event bounds", () => {
    expect(doc.components.schemas.ChatRequest.properties.text).toMatchObject({ minLength: 1, maxLength: 4000 });
    const ev = operations.find((o) => o.id === "listEvents")!.op.parameters;
    expect(ev.find((p: any) => p.name === "limit").schema).toMatchObject({ minimum: 1, maximum: 500 });
    expect(ev.find((p: any) => p.name === "after").schema.minimum).toBe(0);
  });
});
