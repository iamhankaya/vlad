import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advance } from "../../src/actions/advance.ts";
import { vladOps } from "../../src/actions/ops.ts";

// A stand-in for the vlad CLI: logs its arguments and stdin; `audit add` fails like the real duplicate check when $DUP is set.
const FAKE = `
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const stdin = args.includes("-") ? readFileSync(0, "utf8") : "";
appendFileSync(join(process.env.VLAD_HOME, "calls.log"), JSON.stringify({ args, stdin }) + "\\n");
if (args[0] === "audit" && existsDup()) { process.stderr.write(JSON.stringify({ error: "action_id zaten var: A-1" }) + "\\n"); process.exit(1); }
if (args[0] === "audit" && require("node:fs").existsSync(join(process.env.VLAD_HOME, "broken"))) { process.stderr.write("kb-meşgul\\n"); process.exit(1); }
if (args[0] === "task" && args[1] === "ready") process.stdout.write(JSON.stringify({ tasks: [{ id: "T20261025-62" }, { id: "T20261025-63" }], held_by_limit: [{ id: "T20261025-64" }] }));
function existsDup() { return require("node:fs").existsSync(join(process.env.VLAD_HOME, "dup")); }
`;
let dir: string;
const saved = { ...process.env };
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vlad-ops-"));
  writeFileSync(join(dir, "fake-cli.cjs"), FAKE);
  process.env.VLAD_HOME = dir;
  process.env.VLAD_CLI = join(dir, "fake-cli.cjs");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  Object.assign(process.env, saved);
});
const calls = () => readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("server: vlad ops", () => {
  it("audit goes through `vlad audit add --file -` with the entry on stdin", async () => {
    await vladOps.addAudit({ action_id: "A-1", kind: "merge_phase" });
    const last = calls().at(-1);
    expect(last.args).toEqual(["audit", "add", "--file", "-"]);
    expect(JSON.parse(last.stdin)).toEqual({ action_id: "A-1", kind: "merge_phase" });
  });

  it("an existing action_id is success; any other CLI failure propagates", async () => {
    writeFileSync(join(dir, "dup"), "");
    await expect(vladOps.addAudit({ action_id: "A-1" })).resolves.toBeUndefined();
    rmSync(join(dir, "dup"));
    writeFileSync(join(dir, "broken"), "");
    await expect(vladOps.addAudit({ action_id: "A-1" })).rejects.toThrow();
    rmSync(join(dir, "broken"));
    expect(existsSync(join(dir, "broken"))).toBe(false);
  });

  it("ready lists only startable phases (held_by_limit stay queued); advance launches them mechanically", async () => {
    expect(await vladOps.ready("T20261024-94")).toEqual(["T20261025-62", "T20261025-63"]);
    const r = await advance(vladOps, "T20261024-94");
    expect(r).toEqual({ started: ["T20261025-62", "T20261025-63"], failed: [] });
    expect(calls().filter((c) => c.args[1] === "launch" || c.args[0] === "task" && c.args[1] === "launch").map((c) => c.args)).toEqual([["task", "launch", "T20261025-62"], ["task", "launch", "T20261025-63"]]);
    expect(await advance(vladOps, null)).toEqual({ started: [], failed: [] });
  });

  it("D6: ids that reach the CLI must be task ids; nothing is spawned for anything else", async () => {
    const before = calls().length;
    for (const bad of ["--help", "T1", "T20261025-6; rm", "../x", "", "t20261025-61", "T20261025-6\n"]) {
      await expect(vladOps.setDone(bad)).rejects.toThrow();
      await expect(vladOps.ready(bad)).rejects.toThrow();
      await expect(vladOps.launch(bad)).rejects.toThrow();
    }
    expect(calls()).toHaveLength(before);
  });
});
