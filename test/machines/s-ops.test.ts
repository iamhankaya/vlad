import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NoopLauncher } from "../../src/launcher/index.js";
import { OP_TABLE, allowedOps, isAllowed, NotImplementedOp } from "../../src/agent/ops/index.js";
import type { AgentOp } from "../../src/machines/index.js";

describe("machines:S ops table (role -> allowed ops)", () => {
  const XFER: AgentOp[] = ["xfer-begin", "xfer-chunk", "xfer-commit", "xfer-abort", "clip-push"]; // aktarım (T20261105-05)
  const WORKER_ON_BRAIN: AgentOp[] = ["ping", "apply-write", ...XFER];
  it("brain may call these on a worker agent", () => {
    expect([...allowedOps("worker-agent", "brain")].sort()).toEqual(["cleanup", "clip-push", "close", "gate-run", "kb-sync", "launch", "liveness", "merge", "merge-preview", "op-status", "ping", "probe-window", "resume", "script-list", "script-run", "xfer-abort", "xfer-begin", "xfer-chunk", "xfer-commit"]);
  });
  it("worker may call only ping/apply-write on the brain agent", () => {
    expect([...allowedOps("brain-agent", "worker")].sort()).toEqual(WORKER_ON_BRAIN.slice().sort());
  });
  it("console may call ping/exec/kb-head on the brain agent", () => {
    expect([...allowedOps("brain-agent", "console")].sort()).toEqual(["exec", "kb-head", "ping"]);
  });
  it("worker cannot launch/cleanup; console cannot apply-write; brain cannot exec", () => {
    expect(isAllowed("worker-agent", "worker", "launch")).toBe(false);
    expect(isAllowed("worker-agent", "worker", "cleanup")).toBe(false);
    for (const op of ["gate-run", "merge-preview", "merge"] as AgentOp[]) {
      expect(isAllowed("worker-agent", "brain", op), op).toBe(true);
      for (const c of ["worker", "console", "self"] as const) expect(isAllowed("worker-agent", c, op), `${c} ${op}`).toBe(false);
      expect(isAllowed("brain-agent", "worker", op), op).toBe(false);
    }
    expect(isAllowed("brain-agent", "console", "apply-write")).toBe(false);
    expect(isAllowed("brain-agent", "brain", "exec")).toBe(false);
    expect(isAllowed("worker-agent", "console", "ping")).toBe(false);
  });
  it("local queue ops are only for the worker agent's own identity (self)", () => {
    for (const op of ["forward-write", "queue-list", "queue-flush", "queue-drop"] as AgentOp[]) {
      expect(isAllowed("worker-agent", "self", op), op).toBe(true);
      expect(isAllowed("worker-agent", "brain", op), op).toBe(false);
      expect(isAllowed("brain-agent", "self", op), op).toBe(false);
    }
  });
  it("every op has a body and none is notImplemented any more", async () => {
    const all = new Set(Object.keys(OP_TABLE));
    for (const op of ["gate-run", "merge-preview", "merge"]) {
      expect(all.has(op), op).toBe(true);
      await expect(OP_TABLE[op as AgentOp]({}, { from: "x", opId: "o" })).rejects.not.toThrow(NotImplementedOp);
    }
    for (const op of ["ping", "op-status", "apply-write", "exec", "kb-head", "forward-write", "queue-list", "queue-flush", "queue-drop", "liveness"]) expect(all.has(op), op).toBe(true);
  });
});

describe("machines:S NoopLauncher log", () => {
  it("VLAD_NOOP_LOG appends one JSONL line {taskId,cwd,title} per launch", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "vlad-noop-")), "noop.jsonl");
    process.env.VLAD_NOOP_LOG = log;
    try {
      const l = new NoopLauncher();
      await l.launch({ taskId: "T20261101-99", cwd: "/w/a", prompt: "p", env: {}, title: "t1" });
      await l.launch({ taskId: "T20261101-98", cwd: "/w/b", prompt: "p", env: {}, title: "t2" });
    } finally { delete process.env.VLAD_NOOP_LOG; }
    const lines = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    expect(lines).toEqual([{ taskId: "T20261101-99", cwd: "/w/a", title: "t1" }, { taskId: "T20261101-98", cwd: "/w/b", title: "t2" }]);
  });
  it("without VLAD_NOOP_LOG nothing is written", async () => {
    delete process.env.VLAD_NOOP_LOG;
    await expect(new NoopLauncher().launch({ taskId: "T20261101-97", cwd: "/w", prompt: "p", env: {}, title: "t" })).resolves.toMatchObject({ ok: true, method: "noop" });
  });
});

describe("machines:S gitignore", () => {
  it("ignores the local settings and agent state", () => {
    const g = readFileSync(".gitignore", "utf8");
    expect(g).toContain("/vlad.local.json");
    expect(g).toContain("/.vlad-agent/");
  });
});
