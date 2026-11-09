import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runSpawn, spawnGuarded, spawnVlad } from "./spawn-vlad.js";

const node = process.execPath;

describe("runSpawn", () => {
  it("returns status and captured output of a normal run", () => {
    const r = runSpawn(node, ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"]);
    expect(r).toMatchObject({ status: 3, stdout: "out", stderr: "err", timedOut: false, signal: null });
    expect(r.spawnError).toBeUndefined();
  });

  it("feeds input to stdin", () => {
    const r = runSpawn(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello" });
    expect(r.stdout).toBe("hello");
  });

  it("cuts a hanging child at the timeout with SIGKILL (does not throw)", () => {
    const t0 = Date.now();
    // 20 s sleep vs 400 ms limit: the margin is wide enough to hold under heavy parallel load
    const r = runSpawn(node, ["-e", "setTimeout(()=>{},20000)"], { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGKILL");
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("kills a child that ignores SIGTERM (SIGKILL, not SIGTERM)", () => {
    const r = runSpawn(node, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>{},20000)"], { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGKILL");
  });

  it("reports a spawn failure in the result instead of throwing", () => {
    const r = runSpawn(join(tmpdir(), "vlad-no-such-binary-xyz"), []);
    expect(r.status).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toMatch(/ENOENT/);
  });

  it("stops a child that exceeds maxBuffer and flags it", () => {
    const r = runSpawn(node, ["-e", "process.stdout.write('x'.repeat(200000))"], { maxBuffer: 1000 });
    expect(r.spawnError).toMatch(/ENOBUFS|maxBuffer/);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.length).toBeLessThan(200000);
  });
});

describe("isolatedEnv", () => {
  it("does not spread process.env: unrelated and VLAD_* shell variables stay out", () => {
    process.env.VLAD_ISOLATION_PROBE = "leak";
    process.env.ZZ_ISOLATION_PROBE = "leak";
    try {
      const e = isolatedEnv();
      expect(e.VLAD_ISOLATION_PROBE).toBeUndefined();
      expect(e.ZZ_ISOLATION_PROBE).toBeUndefined();
      expect(e.PATH).toBeTruthy();
    } finally {
      delete process.env.VLAD_ISOLATION_PROBE;
      delete process.env.ZZ_ISOLATION_PROBE;
    }
  });

  it("points HOME at a temp dir, not the real home", () => {
    const e = isolatedEnv();
    expect(e.HOME).toBeTruthy();
    expect(e.HOME).not.toBe(process.env.HOME);
    expect(existsSync(e.HOME as string)).toBe(true);
    expect((e.HOME as string).startsWith(tmpdir())).toBe(true);
  });

  it("keeps the test-provided guards and passes through what the test gives", () => {
    const e = isolatedEnv({ VLAD_HOME: "/x", FOO: "bar" });
    expect(e).toMatchObject({ VLAD_HOME: "/x", FOO: "bar", VLAD_LAUNCHER: "noop", VLAD_NO_NATIVE: "1" });
  });

  it("gives git a commit identity so spawned commits work without a global gitconfig", () => {
    expect(isolatedEnv()).toMatchObject({ GIT_AUTHOR_NAME: expect.any(String), GIT_AUTHOR_EMAIL: expect.any(String), GIT_COMMITTER_NAME: expect.any(String), GIT_COMMITTER_EMAIL: expect.any(String) });
    expect(isolatedEnv({ GIT_AUTHOR_NAME: "x" }).GIT_AUTHOR_NAME).toBe("x");
  });

  it("lets an explicit HOME win", () => {
    expect(isolatedEnv({ HOME: "/h" }).HOME).toBe("/h");
  });

  it("normalizes a Windows-style Path to PATH", () => {
    const saved = { PATH: process.env.PATH, Path: process.env.Path };
    try {
      delete process.env.PATH;
      process.env.Path = "/win/bin";
      const e = isolatedEnv();
      expect(e.PATH).toBe("/win/bin");
      expect(e.Path).toBeUndefined();
    } finally {
      if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
      if (saved.Path === undefined) delete process.env.Path; else process.env.Path = saved.Path;
    }
  });
});

describe("spawnVlad", () => {
  it("runs the built CLI with an isolated env (smoke: --help)", () => {
    const home = mkdtempSync(join(tmpdir(), "vlad-sv-"));
    const r = spawnVlad({ args: ["--help"], env: { VLAD_HOME: home } });
    expect(r.spawnError).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage|vlad/i);
    expect(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")).toContain("vlad");
  });
});

describe("spawnGuarded (F-vlad-258: drop-in spawnSync with timeout/maxBuffer guard)", () => {
  it("cuts a hanging child with SIGKILL instead of hanging the run", () => {
    const r = spawnGuarded(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { encoding: "utf8", timeout: 400 });
    expect(r.signal).toBe("SIGKILL");
  });

  it("applies a default timeout and keeps caller options (env/input/encoding)", () => {
    const r = spawnGuarded(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { encoding: "utf8", input: "hi" });
    expect(r.stdout).toBe("hi");
    expect(r.status).toBe(0);
  });
});
