import { describe, expect, it } from "vitest";
import { TRANSITIONS, TransitionError, assertTransition, canTransition } from "../../src/tasks/index.js";
import type { TaskState } from "../../src/kb/index.js";

const ALLOWED: Record<string, string[]> = {
  queued: ["running", "cancelled"],
  running: ["blocked", "awaiting_approval", "failed", "stalled", "cancelled"],
  blocked: ["running", "cancelled"],
  stalled: ["running", "cancelled"],
  awaiting_approval: ["done", "running", "cancelled"],
  failed: ["queued", "cancelled"],
  done: [],
  cancelled: [],
};

describe("state machine", () => {
  it("allows every pair in spec 5.2", () => {
    for (const [from, tos] of Object.entries(ALLOWED)) {
      for (const to of tos) expect(canTransition(from as TaskState, to as TaskState)).toBe(true);
    }
  });
  it("matches the table exactly", () => {
    expect(TRANSITIONS).toEqual(ALLOWED);
  });
  it("rejects invalid pairs", () => {
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("queued", "done")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
  });
  it("assertTransition lists allowed targets", () => {
    expect(() => assertTransition("queued", "done")).toThrow(TransitionError);
    try {
      assertTransition("queued", "done");
    } catch (e) {
      expect((e as Error).message).toContain("running");
      expect((e as Error).message).toContain("cancelled");
    }
  });
});
