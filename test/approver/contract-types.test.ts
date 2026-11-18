import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/approver/types.js";
import * as request from "../../src/approver/request.js";
import * as store from "../../src/approver/store.js";
import * as ntfy from "../../src/approver/ntfy.js";
import * as service from "../../src/approver/service.js";
import * as exec from "../../src/approver/exec.js";
import * as launchd from "../../src/approver/launchd.js";

// approver sözleşmesi (T20261116-04): şekil = imza, sabitler, dışa aktarımlar. İş mantığı U-fazlarında; burada gövdeye bağlı iddia yok.
describe("approver sözleşmesi: LIMITS", () => {
  it("plandaki değerler birebir (değişirse sözleşme itirazı: vlad task ask)", () => {
    expect(LIMITS).toEqual({
      approveTtlMs: 300_000, tokenTtlMs: 60_000, maxTokenTtlMs: 120_000, maxArgvBytes: 8192, maxValueBytes: 200,
      cooldownMs: 30_000, perHour: 6, perDay: 20, lockAfterDenied: 3, lockMs: 3_600_000, execTimeoutMs: 300_000,
      ackWaitMs: 15_000, waitSlackMs: 10_000, maxInboxFiles: 20, maxInboxBytes: 160_000, maxOutputBytes: 65_536,
    });
  });
});

describe("approver sözleşmesi: dışa aktarılan imzalar (ad + arite)", () => {
  const fn = (m: Record<string, unknown>, name: string, arity: number) => {
    expect(typeof m[name], name).toBe("function");
    expect((m[name] as (...a: unknown[]) => unknown).length, `${name}.length`).toBe(arity);
  };
  it("request.ts", () => {
    fn(request, "validateRequest", 1); fn(request, "computeDigest", 1); fn(request, "approveTag", 2); fn(request, "denyTag", 2);
    fn(request, "keyGen", 1); fn(request, "parseDecision", 4); fn(request, "renderNotification", 1);
    fn(request, "newId", 1); fn(request, "newNonce", 1); fn(request, "newTopic", 2);
  });
  it("store.ts, ntfy.ts, service.ts, exec.ts, launchd.ts", () => {
    fn(store, "createStore", 1);
    expect(typeof ntfy.NtfyChannel).toBe("function");
    fn(service, "runApprover", 1);
    fn(exec, "defaultExecEnv", 1); fn(exec, "createExecutor", 0);
    fn(launchd, "createLaunchdInstaller", 0);
  });
  it("NtfyChannel: ApproverChannel yöntemleri prototipte", () => {
    for (const m of ["publishRequest", "watchResponse", "publishResult"]) expect(typeof (ntfy.NtfyChannel.prototype as unknown as Record<string, unknown>)[m], m).toBe("function");
  });
});
