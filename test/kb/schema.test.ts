import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError, validate } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

const task = {
  id: "T20261015-01", project: "watchparty", title: "t", kind: "dev", state: "queued",
  autonomy: "commit", branch: null, worktree: null, session_id: null,
  created: "2026-10-15T21:10:00+03:00", updated: "2026-10-15T21:10:00+03:00", error: null,
};

describe("schema", () => {
  beforeEach(() => { makeHome(); });
  it("accepts valid task", () => {
    expect(() => validate("task", task)).not.toThrow();
  });
  it("rejects bad state with path in details", () => {
    let err: unknown;
    try { validate("task", { ...task, state: "bogus" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).details.join("\n")).toContain("/state");
  });
  it("rejects bad id", () => {
    expect(() => validate("task", { ...task, id: "X1" })).toThrow(ValidationError);
  });
});
