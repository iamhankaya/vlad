import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { isolatedEnv, spawnVlad } from "../support/spawn-vlad.js";

const DIST = join(import.meta.dirname, "..", "..", "dist");
let home: string;
beforeEach(() => { home = makeHome(); });

// F-vlad-099 (a): swallowEpipe against a real closed pipe, not an emitted fake error
describe("swallowEpipe on a real pipe", () => {
  const run = (swallow: boolean) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const stdoutUrl = join(DIST, "stdout.js");
    const src = `${swallow ? `const {swallowEpipe}=await import(${JSON.stringify("file://" + stdoutUrl)});swallowEpipe(process.stdout);` : ""}`
      + `const chunk="x".repeat(65536);for(let i=0;i<200;i++){process.stdout.write(chunk);await new Promise(r=>setTimeout(r,5));}process.exit(0);`;
    const c = spawn(process.execPath, ["--input-type=module", "-e", src], { env: isolatedEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    c.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    c.stdout.once("data", () => c.stdout.destroy()); // the reader goes away after the first chunk (`vlad … | head`)
    const timer = setTimeout(() => c.kill("SIGKILL"), 20_000);
    c.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });

  it("without the guard a closed reader crashes the writer with EPIPE (the test really exercises the pipe)", async () => {
    const r = await run(false);
    expect(r.stderr).toMatch(/EPIPE/);
    expect(r.code).not.toBe(0);
  });

  it("with swallowEpipe the writer survives a reader that closed early", async () => {
    const r = await run(true);
    expect(r.stderr).not.toMatch(/EPIPE/);
    expect(r.code).toBe(0);
  });
});

// F-vlad-099 (b): `status --no-mark` must skip expireMode (a real elapsed window stays in mode.json), plain `status` clears it
describe("status --no-mark keeps an elapsed mode window", () => {
  const modeFile = () => join(home, "kb", "mode.json");
  const writeElapsed = () => {
    mkdirSync(join(home, "kb"), { recursive: true });
    const night = { until: "2020-01-01T10:00:00+03:00", started: "2020-01-01T08:00:00+03:00", projects: [], note: null, push: false, except: [], untilTasks: [] };
    writeFileSync(modeFile(), JSON.stringify({ night, watch: false }));
  };
  const status = (...extra: string[]) => spawnVlad({ args: ["status", "--summary", "--json", ...extra], env: { VLAD_HOME: home } });

  it("--no-mark leaves mode.json untouched and still reports the expired window", () => {
    writeElapsed();
    const before = readFileSync(modeFile(), "utf8");
    const r = status("--no-mark");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("gece modu bitti");
    expect(readFileSync(modeFile(), "utf8")).toBe(before);
  });

  it("plain status reports it once and clears it", () => {
    writeElapsed();
    const first = status();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("gece modu bitti");
    expect(existsSync(modeFile())).toBe(false);
  });
});
