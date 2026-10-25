import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activeRuns, classifyVladError, MAX_CONCURRENT, runVlad, runVladJson, VladError } from "../../src/vlad/cli.ts";

// A stand-in for dist/cli.js: behaviour picked by the first argument, state kept under $VLAD_HOME.
const FAKE = `
const { appendFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const home = process.env.VLAD_HOME;
const [mode, ...rest] = process.argv.slice(2);
if (mode === "echo") {
  process.stdout.write(JSON.stringify({ args: rest, env: Object.keys(process.env).filter((k) => k !== "PATH" && k !== "HOME").sort(), kb: process.env.VLAD_KB_DIR ?? null }));
} else if (mode === "hang") {
  writeFileSync(join(home, "pid"), String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "hold") {
  const mark = join(home, "run-" + process.pid);
  writeFileSync(mark, "");
  appendFileSync(join(home, "max.log"), readdirSync(home).filter((f) => f.startsWith("run-")).length + "\\n");
  setTimeout(() => { rmSync(mark); }, 120);
} else if (mode === "fail") {
  process.stderr.write(JSON.stringify({ error: rest[0], details: ["d1"] }) + "\\n");
  process.exit(1);
}
`;

let dir: string;
const saved = { ...process.env };
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vlad-runvlad-"));
  writeFileSync(join(dir, "fake-cli.cjs"), FAKE);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});
const useFake = (extra: Record<string, string> = {}) => {
  process.env.VLAD_HOME = dir;
  process.env.VLAD_CLI = join(dir, "fake-cli.cjs");
  Object.assign(process.env, extra);
};

describe("server: runVlad", () => {
  it("passes arguments verbatim without a shell", async () => {
    useFake();
    const out = JSON.parse(await runVlad(["echo", "; touch pwned", "$(id)", "a b", "--json"]));
    expect(out.args).toEqual(["; touch pwned", "$(id)", "a b", "--json"]);
    expect(existsSync(join(process.cwd(), "pwned"))).toBe(false);
  });

  it("server: runVlad child env carries VLAD_HOME and VLAD_KB_DIR but no other variable", async () => {
    useFake({ VLAD_KB_DIR: "/kb/x", FCM_SERVICE_ACCOUNT: "secret", GITHUB_TOKEN: "ghp_secret", VLAD_CLI_EXTRA: "1" });
    const out = JSON.parse(await runVlad(["echo"]));
    expect(out.env).toEqual(["VLAD_HOME", "VLAD_KB_DIR"]);
    expect(out.kb).toBe("/kb/x");
  });

  it("server: runVlad timeout kills process", async () => {
    useFake();
    // generous: the child must have written its pid before the timer fires, even on a loaded machine
    const run = runVlad(["hang"], { timeoutMs: 3000 }).then(() => null, (e) => e);
    const e = await run;
    expect(e).toBeInstanceOf(VladError);
    expect(e.kind).toBe("timeout");
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
    expect(activeRuns()).toBe(0);
  });

  it("abort signal ends the run as aborted", async () => {
    useFake();
    const ac = new AbortController();
    const p = runVlad(["hang"], { timeoutMs: 20_000, signal: ac.signal }).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    expect((await p).kind).toBe("aborted");
    expect((await runVlad(["echo"], { signal: AbortSignal.abort() }).then(() => null, (e) => e)).kind).toBe("aborted");
  });

  it("server: runVlad concurrency capped", async () => {
    useFake();
    const log = join(dir, "max.log");
    writeFileSync(log, "");
    for (const f of readdirSync(dir)) if (f.startsWith("run-")) rmSync(join(dir, f));
    await Promise.all(Array.from({ length: 12 }, () => runVlad(["hold"])));
    const seen = readFileSync(log, "utf8").trim().split("\n").map(Number);
    expect(seen).toHaveLength(12);
    expect(Math.max(...seen)).toBeLessThanOrEqual(MAX_CONCURRENT);
    expect(activeRuns()).toBe(0);
  });

  it("a failing run keeps the slot count right", async () => {
    useFake();
    await Promise.all(Array.from({ length: 6 }, () => runVlad(["fail", "x"]).catch(() => null)));
    expect(activeRuns()).toBe(0);
  });

  it("runVladJson appends --json and rejects non-JSON output", async () => {
    useFake();
    expect((await runVladJson<{ args: string[] }>(["echo", "a"])).args).toEqual(["a", "--json"]);
    await expect(runVladJson(["hold"])).rejects.toMatchObject({ kind: "failed" });
  });

  it("missing VLAD_HOME or cli is a spawn error, not a crash", async () => {
    delete process.env.VLAD_HOME;
    await expect(runVlad(["echo"])).rejects.toMatchObject({ kind: "spawn" });
    process.env.VLAD_HOME = dir;
    process.env.VLAD_CLI = join(dir, "nope.cjs");
    await expect(runVlad(["echo"])).rejects.toMatchObject({ kind: "failed" }); // node exits 1: module not found
  });

  it("server: index.lock or push failure surfaces as error code", async () => {
    useFake();
    const cases: [string, string][] = [
      ["active_elsewhere: etkin VLAD \"pc\" (nabız 1 dk önce)", "active_elsewhere"],
      ["Unable to create '/kb/.git/index.lock': File exists.", "index_lock"],
      ["lock bekleme zaman aşımı: kb-meşgul", "kb_busy"],
      ["! [rejected] main -> main (non-fast-forward)", "push_failed"],
      ["görev bulunamadı: T20261025-99", "not_found"],
      ["başka bir şey", "failed"],
    ];
    for (const [msg, kind] of cases) {
      const e = await runVlad(["fail", msg]).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(VladError);
      expect(e.kind).toBe(kind);
      expect(e.details).toEqual(["d1"]);
      expect(classifyVladError(msg).kind).toBe(kind); // plain-text stderr (no --json) classifies the same
    }
  });
});
