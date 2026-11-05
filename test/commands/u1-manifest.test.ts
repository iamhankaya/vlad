import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/commands/manifest.js";
import { keyOf, validateManifest } from "../../src/commands/types.js";
import { consoleCatalog, forwardMap, kbWriteKeys, lockPolicyFor, refreshKeys, workerLocalKeys, consoleTimeoutMs } from "../../src/commands/accessors.js";
import { KB_WRITES, REFRESH_KEYS } from "../../src/cli/program.js";
import { FORWARD, WORKER_LOCAL } from "../../src/agent/forward.js";
import { CONSOLE_CATALOG, consoleExecTimeoutMs, validateConsoleArgv } from "../../src/agent/console-catalog.js";
import { INNER_LOCK, lockPolicyOf } from "../../src/machines/lock-policy.js";

// Equivalence baseline: the hand-kept sets as they were before U1 (scripts/capture-legacy-classes.mjs on the pre-manifest build).
const legacy = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/legacy-classes.json"), "utf8")) as {
  KB_WRITES: string[]; REFRESH_KEYS: string[]; WORKER_LOCAL: string[]; FORWARD: Record<string, string>; INNER_LOCK: string[];
  CONSOLE_CATALOG: { path: string[]; kind: "read" | "write"; fileFlags?: string[] }[];
};
const sorted = (s: Iterable<string>) => [...s].sort();
const byPath = <T extends { path: string[] }>(a: readonly T[]) => [...a].sort((x, y) => x.path.join(" ").localeCompare(y.path.join(" ")));

describe("u1-manifest: manifest is valid", () => {
  it("has no validation errors (keys unique, refresh ⇒ outer, console none has a reason)", () => {
    expect(COMMANDS.length).toBeGreaterThan(60);
    expect(validateManifest(COMMANDS)).toEqual([]);
  });
  it("`remote` is the plain-registered one, every other command goes through def()", () => {
    expect(COMMANDS.filter((s) => s.registration === "plain").map((s) => s.path.join(" "))).toEqual(["remote"]);
  });
  it("only `vlad status` has the status exec branch", () => {
    expect(COMMANDS.filter((s) => s.exec === "status").map(keyOf)).toEqual(["vlad status"]);
  });
});

describe("u1-manifest: accessors reproduce the old hand-kept sets exactly", () => {
  it("kbWriteKeys = old KB_WRITES; program.ts exports the derived set", () => {
    expect(sorted(kbWriteKeys())).toEqual(legacy.KB_WRITES);
    expect(sorted(KB_WRITES)).toEqual(legacy.KB_WRITES);
  });
  it("refreshKeys = old REFRESH_KEYS", () => {
    expect(sorted(refreshKeys())).toEqual(legacy.REFRESH_KEYS);
    expect(sorted(REFRESH_KEYS)).toEqual(legacy.REFRESH_KEYS);
  });
  it("workerLocalKeys = old WORKER_LOCAL; forward.ts exports the derived set", () => {
    expect(sorted(workerLocalKeys())).toEqual(legacy.WORKER_LOCAL);
    expect(sorted(WORKER_LOCAL)).toEqual(legacy.WORKER_LOCAL);
  });
  it("forwardMap = old FORWARD", () => {
    expect(forwardMap()).toEqual(legacy.FORWARD);
    expect(FORWARD).toEqual(legacy.FORWARD);
  });
  it("INNER_LOCK = the phased commands", () => {
    expect(sorted(INNER_LOCK)).toEqual(legacy.INNER_LOCK);
  });
  it("console catalog entries (path, kind, fileFlags) = old CONSOLE_CATALOG", () => {
    expect(byPath(CONSOLE_CATALOG)).toEqual(byPath(legacy.CONSOLE_CATALOG));
    expect(Object.keys(consoleCatalog()).filter((k) => consoleCatalog()[k]!.kind !== "none").length).toBe(legacy.CONSOLE_CATALOG.length);
  });
  it("lock policy matches lockPolicyOf for every key, with and without machines", () => {
    const keys = COMMANDS.map(keyOf);
    const legacyKb = new Set(legacy.KB_WRITES);
    for (const machines of [undefined, [{ name: "a" }] as never]) {
      for (const k of keys) {
        const cfg = { machines } as { machines?: never };
        const old = lockPolicyOf(k, legacyKb, legacy.INNER_LOCK.includes(k) ? cfg : {});
        expect(lockPolicyFor(k, () => cfg), `${k} machines=${!!machines}`).toBe(old);
      }
    }
  });
  it("getCfg is read only for phased commands (a broken config must not stop `scan`)", () => {
    const boom = () => { throw new Error("config bozuk"); };
    for (const s of COMMANDS) {
      if (s.lock === "phased") continue;
      expect(() => lockPolicyFor(keyOf(s), boom), keyOf(s)).not.toThrow();
    }
    expect(() => lockPolicyFor("task resume", boom)).toThrow(/config bozuk/);
  });
});

describe("u1-manifest: console timeouts and validation stay the same", () => {
  it("consoleExecTimeoutMs: gate 31 min, merge 6 min, rest 110 s", () => {
    expect(consoleExecTimeoutMs(["task", "gate", "T1"])).toBe(31 * 60_000);
    expect(consoleExecTimeoutMs(["task", "merge", "T1"])).toBe(6 * 60_000);
    expect(consoleExecTimeoutMs(["task", "list"])).toBe(110_000);
    expect(consoleExecTimeoutMs(["scan"])).toBe(110_000);
    expect(consoleTimeoutMs(["task", "gate"])).toBe(31 * 60_000);
  });
  it("only task gate / task merge carry a console timeoutMs", () => {
    expect(COMMANDS.filter((s) => s.console.kind !== "none" && s.console.timeoutMs !== undefined).map(keyOf).sort()).toEqual(["task gate", "task merge"]);
  });
  it("catalog entries do not alias manifest arrays", () => {
    for (const e of CONSOLE_CATALOG) {
      if (!e.fileFlags) continue;
      const spec = COMMANDS.find((s) => s.path.join(" ") === e.path.join(" "))!;
      expect(e.fileFlags, e.path.join(" ")).not.toBe((spec.console as { fileFlags: string[] }).fileFlags);
    }
  });
  it("validateConsoleArgv: allowed commands pass, off-catalog ones are forbidden (negative cases kept)", () => {
    expect(validateConsoleArgv(["task", "list", "--json"]).entry.path).toEqual(["task", "list"]);
    expect(validateConsoleArgv(["project", "write", "x", "--file", "-"], "# kart").entry.fileFlags).toEqual(["--file"]);
    for (const argv of [["task", "release", "T1"], ["audit", "setup"], ["agent", "start"], ["machine", "list"], ["queue", "list"], ["remote", "--", "x"], ["install"], ["send", "a"], ["clip", "on"]]) {
      expect(() => validateConsoleArgv(argv), argv.join(" ")).toThrow(/forbidden/);
    }
  });
});

describe("u1-manifest: policy invariants (documented, deliberate)", () => {
  it("console `read` with a kb write lock only for `mode status` (and `vlad status` via the status branch)", () => {
    const odd = COMMANDS.filter((s) => s.console.kind === "read" && (s.lock !== "none" || s.exec === "status")).map(keyOf).sort();
    expect(odd).toEqual(["mode status", "vlad status"]);
  });
  it("task release and audit setup are explicit in the manifest: no console, rejected on workers (as before)", () => {
    for (const k of ["task release", "audit setup"]) {
      const s = COMMANDS.find((c) => keyOf(c) === k)!;
      expect(s, k).toBeDefined();
      expect(s.console.kind).toBe("none");
      expect(s.worker).toEqual({ kind: "reject" });
    }
  });
  it("worker policy: local = old WORKER_LOCAL, forward = old FORWARD, everything else rejects (fail-closed)", () => {
    for (const s of COMMANDS) {
      const k = keyOf(s);
      if (legacy.WORKER_LOCAL.includes(k)) expect(s.worker.kind, k).toBe("local");
      else if (legacy.FORWARD[k]) expect(s.worker, k).toEqual({ kind: "forward", op: legacy.FORWARD[k] });
      else expect(s.worker.kind, k).toBe("reject");
    }
  });
  it("forwarded commands write the kb (the brain applies them under its lock)", () => {
    for (const s of COMMANDS) if (s.worker.kind === "forward") expect(s.lock, keyOf(s)).toBe("outer");
  });
});
