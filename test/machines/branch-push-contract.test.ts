import { describe, expect, it } from "vitest";
import { OP_TABLE, NotImplementedOp, allowedOps, isAllowed } from "../../src/agent/ops/index.js";
import { parseBranchPushArgs } from "../../src/agent/ops/branch-push.js";
import {
  BRANCH_PUSH_BRANCH_RE, BRANCH_PUSH_REASONS, BRANCH_PUSH_REMOTE, BRANCH_PUSH_TIMEOUT_MS, RemoteError,
  type AgentOp, type BranchPushArgs,
} from "../../src/fleet/types.js";
import { fetchTaskBranch } from "../../src/machines/remote.js";

// Sözleşme testleri (T20261111-50, F-vlad-314): yalnız şekil — imza, tür, hata biçimi. Git davranışı uygulama fazındadır.

const SHA = "a".repeat(40);
const good: BranchPushArgs = { taskId: "T20261111-50", project: "vlad", repoName: "vlad", branch: "vlad/T20261111-50", expectHead: SHA };
const badRequest = (a: unknown) => { try { parseBranchPushArgs(a); } catch (e) { return e as RemoteError; } return null; };

describe("branch-push contract: roles and op table", () => {
  const op: AgentOp = "branch-push";
  it("only the brain may call it on a worker agent; nobody else, no brain-agent", () => {
    expect(isAllowed("worker-agent", "brain", op)).toBe(true);
    for (const c of ["worker", "console", "self"] as const) expect(isAllowed("worker-agent", c, op), c).toBe(false);
    for (const c of ["brain", "worker", "console", "self"] as const) expect(allowedOps("brain-agent", c), c).not.toContain(op);
  });
  it("body is a stub: valid args reach NotImplementedOp, invalid args fail validation first", async () => {
    await expect(OP_TABLE[op](good, { from: "mac", opId: "o" })).rejects.toBeInstanceOf(NotImplementedOp);
    await expect(OP_TABLE[op]({ ...good, branch: "main" }, { from: "mac", opId: "o" })).rejects.not.toBeInstanceOf(NotImplementedOp);
  });
});

describe("branch-push contract: constants", () => {
  it("branch regex accepts only vlad/<taskId>", () => {
    for (const ok of ["vlad/T20261111-50", "vlad/T20261111-5", "vlad/T20261111-123"]) expect(BRANCH_PUSH_BRANCH_RE.test(ok), ok).toBe(true);
    for (const no of ["main", "master", "refs/heads/vlad/T20261111-50", "+vlad/T20261111-50", "vlad/T20261111-50:main", "vlad/T20261111-50:vlad/T20261111-50",
      "vlad/T20261111-50\n", "vlad/T20261111-50/x", "vlad/../T20261111-50", "vlad/T2026111-50", "vlad/x", "vlad/T20261111-", "v/T20261111-50", "tags/v1", "", "HEAD"]) {
      expect(BRANCH_PUSH_BRANCH_RE.test(no), JSON.stringify(no)).toBe(false);
    }
  });
  it("remote is origin, timeout 120 s, reasons are the planned set", () => {
    expect(BRANCH_PUSH_REMOTE).toBe("origin");
    expect(BRANCH_PUSH_TIMEOUT_MS).toBe(120_000);
    expect([...BRANCH_PUSH_REASONS]).toEqual(["diverged", "no_origin", "stale_tip", "push_rejected", "auth"]);
  });
});

describe("branch-push contract: request schema", () => {
  it("accepts the exact 5-field request", () => { expect(parseBranchPushArgs(good)).toEqual(good); });
  it("rejects non-objects and unknown fields (force, refspec, remote, tags, path) as bad_request", () => {
    for (const a of [null, undefined, "x", 1, [], [good]]) expect(badRequest(a)?.code, JSON.stringify(a)).toBe("bad_request");
    for (const extra of [{ force: true }, { refspec: "+a:b" }, { remote: "evil" }, { url: "https://x" }, { tags: true }, { cwd: "/tmp" }, { delete: true }]) {
      expect(badRequest({ ...good, ...extra })?.code, JSON.stringify(extra)).toBe("bad_request");
    }
  });
  it("rejects a branch other than vlad/<taskId>, incl. refspec forms and another task's branch", () => {
    for (const branch of ["main", "refs/heads/main", "+vlad/T20261111-50", "vlad/T20261111-50:main", "refs/heads/vlad/T20261111-50", "vlad/T20261111-51", "vlad/T20261111-50 ", "-f", "--force", "", 7, null]) {
      expect(badRequest({ ...good, branch })?.code, JSON.stringify(branch)).toBe("bad_request");
    }
    expect(badRequest({ ...good, branch: undefined })?.code).toBe("bad_request");
  });
  it("rejects bad ids/paths and non-40-hex heads", () => {
    for (const p of [{ taskId: "x" }, { taskId: "../T20261111-50" }, { project: "../x" }, { project: "" }, { repoName: "a/b" }, { repoName: ".." }]) {
      expect(badRequest({ ...good, ...p })?.code, JSON.stringify(p)).toBe("bad_request");
    }
    for (const expectHead of ["", "main", "HEAD", "A".repeat(40), "a".repeat(39), "a".repeat(41), "a".repeat(7), `${SHA}\n`, 1, null]) {
      expect(badRequest({ ...good, expectHead })?.code, JSON.stringify(expectHead)).toBe("bad_request");
    }
  });
  it("validation errors are RemoteError with a bad_request: message", () => {
    const e = badRequest({ ...good, force: true });
    expect(e).toBeInstanceOf(RemoteError);
    expect(e?.message).toMatch(/^bad_request: /);
  });
});

describe("branch-push contract: brain-side stubs", () => {
  it("fetchTaskBranch is a stub until the implementation phase", async () => {
    await expect(fetchTaskBranch({} as never, SHA)).rejects.toThrow(/gerçeklenmedi/);
  });
});
