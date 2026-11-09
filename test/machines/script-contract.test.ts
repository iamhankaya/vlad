import { describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  OP_TABLE, NotImplementedOp, allowedOps, isAllowed,
} from "../../src/agent/ops/index.js";
import {
  SCRIPT_FILE_RE, SCRIPT_LIMITS, SCRIPT_NAME_RE, SCRIPT_PARAM_TYPES, SCRIPT_REASONS, SCRIPT_RESULT_SENTINEL,
  type AgentCode, type AgentOp, type ScriptInfo, type ScriptManifest, type ScriptRunArgs, type ScriptRunResult,
} from "../../src/fleet/types.js";
import { scriptPlanId, validateScriptManifest } from "../../src/agent/scripts/manifest.js";
import { COMMANDS } from "../../src/commands/manifest.js";
import { buildProgram } from "../../src/cli/program.js";
import type { CliCtx } from "../../src/cli/program.js";
import { Writable } from "node:stream";

// Sözleşme testleri (T20261109-05): yalnız şekil — imza, tür, hata biçimi. İş mantığı sonraki fazlardadır.

describe("scripts contract: ops and roles", () => {
  const OPS: AgentOp[] = ["script-list", "script-run"];
  it("only brain may call script ops on a worker agent", () => {
    for (const op of OPS) {
      expect(isAllowed("worker-agent", "brain", op), op).toBe(true);
      for (const c of ["worker", "console", "self"] as const) expect(isAllowed("worker-agent", c, op), `${c} ${op}`).toBe(false);
      for (const c of ["brain", "worker", "console", "self"] as const) expect(allowedOps("brain-agent", c), `brain-agent ${c}`).not.toContain(op);
    }
  });
  it("op table has a slot for each script op (body: not implemented until the implementation phase)", async () => {
    for (const op of OPS) {
      expect(typeof OP_TABLE[op], op).toBe("function");
      await expect(OP_TABLE[op]({}, { from: "mac", opId: "o" })).rejects.toBeInstanceOf(NotImplementedOp);
    }
  });
});

describe("scripts contract: constants", () => {
  it("reason set is the closed list the spec fixes (no new AgentCode)", () => {
    expect([...SCRIPT_REASONS].sort()).toEqual([
      "approval", "bad_manifest", "bad_name", "bad_param", "dirty", "hash_mismatch", "no_repo", "no_upstream",
      "no_variant", "not_in_head", "not_regular", "unpushed", "unregistered",
    ]);
    const codes: AgentCode[] = ["bad_request", "not_found", "forbidden", "failed", "busy", "conflict"]; // reasons ride on existing codes
    expect(codes).toHaveLength(6);
  });
  it("name regex: lowercase slug, no path chars, max 48", () => {
    for (const ok of ["repo-guncelle", "vlad-guncelle", "a", "a1-b2"]) expect(SCRIPT_NAME_RE.test(ok), ok).toBe(true);
    for (const bad of ["rm -rf", "..\\x", "a/b", "x.ps1", "A", "1a", "", "a".repeat(49), "__proto__", "a\0b"]) expect(SCRIPT_NAME_RE.test(bad), bad).toBe(false);
  });
  it("file regex: flat agent-scripts dir, .ps1/.sh only", () => {
    for (const ok of ["agent-scripts/repo-guncelle.ps1", "agent-scripts/x.sh"]) expect(SCRIPT_FILE_RE.test(ok), ok).toBe(true);
    for (const bad of ["agent-scripts/sub/x.sh", "../x.sh", "agent-scripts/x.js", "agent-scripts/.x.sh", "/etc/x.sh", "agent-scripts/x.ps1\n"]) expect(SCRIPT_FILE_RE.test(bad), bad).toBe(false);
  });
  it("limits keep the journal result under 64 KiB", () => {
    expect(SCRIPT_LIMITS).toEqual({ manifestMaxBytes: 64 * 1024, stdoutKb: 32, stderrKb: 16, resultJsonKb: 16, timeoutSecMax: 3600, outputMaxKbMax: 32, paramMaxLen: 256 });
    expect(SCRIPT_LIMITS.stdoutKb + SCRIPT_LIMITS.stderrKb + SCRIPT_LIMITS.resultJsonKb).toBeLessThanOrEqual(64);
  });
  it("sentinel and param types", () => {
    expect(SCRIPT_RESULT_SENTINEL).toBe("@@VLAD-RESULT@@");
    expect([...SCRIPT_PARAM_TYPES]).toEqual(["string", "enum", "int", "bool", "root"]);
  });
});

describe("scripts contract: type shapes", () => {
  it("manifest, info, run args and result have the planned fields", () => {
    const manifest: ScriptManifest = {
      version: 1,
      scripts: [{
        name: "repo-guncelle", title: "Repo güncelle", platform: "win32", file: "agent-scripts/repo-guncelle.ps1", sha256: "0".repeat(64),
        class: "write", timeoutSec: 900, outputMaxKb: 32, selfUpdate: false, params: [{ name: "root", type: "root", required: false }],
      }],
    };
    const info: ScriptInfo = { ...manifest.scripts[0]!, integrity: "ok" };
    const args: ScriptRunArgs = { name: "repo-guncelle", params: { root: "C:\\dev" }, approval: { planId: "abcd" } };
    const res: ScriptRunResult = {
      name: "repo-guncelle", platform: "win32", head: "a".repeat(40), sha256: "0".repeat(64), exit: 0, timedOut: false, durationMs: 1,
      stdout: "", stderr: "", truncated: { stdout: false, stderr: false }, data: null,
    };
    expect(Object.keys(manifest.scripts[0]!).sort()).toEqual(["class", "file", "name", "outputMaxKb", "params", "platform", "selfUpdate", "sha256", "timeoutSec", "title"]);
    expect(info.integrity).toBe("ok");
    expect(Object.keys(args).sort()).toEqual(["approval", "name", "params"]);
    expect(Object.keys(res).sort()).toEqual(["data", "durationMs", "exit", "head", "name", "platform", "sha256", "stderr", "stdout", "timedOut", "truncated"]);
  });
});

describe("scripts contract: function signatures (bodies land in the implementation phase)", () => {
  it("validateScriptManifest(raw) and scriptPlanId(...) exist with the planned arity", () => {
    expect(validateScriptManifest).toBeTypeOf("function");
    expect(validateScriptManifest.length).toBe(1);
    expect(scriptPlanId).toBeTypeOf("function");
    expect(scriptPlanId.length).toBe(1);
    expect(() => validateScriptManifest({})).toThrow(NotImplementedOp);
    expect(() => scriptPlanId({ machine: "m", name: "n", platform: "win32", sha256: "0".repeat(64), params: {} })).toThrow(NotImplementedOp);
  });
});

describe("scripts contract: CLI skeleton", () => {
  const spec = (p: string[]) => COMMANDS.find((c) => c.path.join(" ") === p.join(" "));
  it("command manifest: brain-only, no console catalog entry, rejected on workers", () => {
    for (const sub of ["scripts", "run"]) {
      const s = spec(["machine", sub]);
      expect(s, sub).toBeDefined();
      expect(s!.worker).toEqual({ kind: "reject" });
      expect(s!.console.kind).toBe("none");
    }
  });
  it("commander tree: machine scripts <ad> / machine run <ad> <betik> with the planned options", () => {
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    const ctx: CliCtx = { cliPath: "/x/dist/cli.js", argv: ["node", "vlad"], stdout: sink, stderr: sink, exit: (c) => { throw new Error(`exit ${c}`); }, env: {} };
    const root: Command = buildProgram(ctx);
    const machine = root.commands.find((c) => c.name() === "machine")!;
    const scripts = machine.commands.find((c) => c.name() === "scripts")!;
    const run = machine.commands.find((c) => c.name() === "run")!;
    expect(scripts.registeredArguments.map((a) => a.name())).toEqual(["ad"]);
    expect(run.registeredArguments.map((a) => a.name())).toEqual(["ad", "betik"]);
    expect(scripts.options.map((o) => o.long).sort()).toEqual(["--json"]);
    expect(run.options.map((o) => o.long).sort()).toEqual(["--confirmed", "--json", "--op-id", "--param", "--plan"]);
    expect(run.options.find((o) => o.long === "--param")!.variadic, "--param tekrarlanabilir").toBe(true);
  });
});
