import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHomePair, spawnVlad } from "../machines/harness.js";
import { rmTemp } from "../helpers.js";
import { isolatedEnv, scrubProcessEnv } from "../isolate-env.js";

// F-vlad-172: the developer's own VLAD_* variables must never reach a test (VLAD_KB_DIR beats the test home's kbDir).
const CARD = `---
slug: alpha
name: Alpha
path: ${JSON.stringify(process.cwd())}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmTemp(d); delete process.env.VLAD_KB_DIR; });

describe("test env isolation (F-vlad-172)", () => {
  it("the worker process carries no user VLAD_* variables beyond the config-provided ones", () => {
    const extra = Object.keys(process.env).filter((k) => k.startsWith("VLAD_") && !["VLAD_LAUNCHER", "VLAD_CLAUDE_JSON", "VLAD_NO_NATIVE", "VLAD_REAL_KB", "VLAD_TEST_SECRET_DIR"].includes(k) && !k.startsWith("VLAD_GOLDEN_"));
    expect(extra).toEqual([]);
  });

  it("isolatedEnv drops user VLAD_* keys, keeps unrelated and config-provided ones", () => {
    const e = isolatedEnv({ VLAD_KB_DIR: "x", VLAD_HOME: "y", VLAD_TASK_ID: "t", VLAD_LAUNCHER: "noop", PATH: "p" });
    expect(e).toEqual({ VLAD_LAUNCHER: "noop", PATH: "p" });
  });

  it("VLAD_REAL_KB opt-in survives isolation (F-vlad-256)", () => {
    expect(isolatedEnv({ VLAD_REAL_KB: "1", VLAD_KB_DIR: "x" })).toEqual({ VLAD_REAL_KB: "1" });
    process.env.VLAD_REAL_KB = "1";
    try { scrubProcessEnv(); expect(process.env.VLAD_REAL_KB).toBe("1"); } finally { delete process.env.VLAD_REAL_KB; }
  });

  it("isolatedEnv/scrubProcessEnv match VLAD_ case-insensitively (Windows env keys; F-vlad-186)", () => {
    const e = isolatedEnv({ vlad_kb_dir: "x", Vlad_Home: "y", vlad_launcher: "noop", VLAD_GOLDEN_UPDATE: "1", Path: "p" });
    expect(e).toEqual({ vlad_launcher: "noop", VLAD_GOLDEN_UPDATE: "1", Path: "p" });
    process.env.vlad_leak_probe = "1"; // on POSIX keys are case-sensitive, so this really is a distinct lowercase key
    try {
      scrubProcessEnv();
      expect(process.env.vlad_leak_probe).toBeUndefined();
    } finally { delete process.env.vlad_leak_probe; }
  });

  it("spawnVlad does not write to a leaked VLAD_KB_DIR (trap stays empty)", () => {
    const trap = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-trap-")));
    dirs.push(trap);
    const pair = makeHomePair();
    try {
      process.env.VLAD_KB_DIR = trap; // simulate a leak reaching the spawn helper
      const card = join(pair.brain.home, "card.md");
      writeFileSync(card, CARD);
      const w = spawnVlad(pair.brain, ["project", "write", "alpha", "--file", card]);
      const n = spawnVlad(pair.brain, ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-"], { stdin: "## Tanım\nx\n" });
      expect([w.code, n.code], w.err + n.err).toEqual([0, 0]);
      expect(readdirSync(join(pair.brain.kb, "tasks")).length).toBe(1); // wrote to the side's own kb
      expect(readdirSync(trap)).toEqual([]);
    } finally { pair.cleanup(); }
  });
});
