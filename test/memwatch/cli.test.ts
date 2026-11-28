import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerMemwatch, type MemwatchCliDeps } from "../../src/cli/groups/memwatch.js";
import { createKit } from "../../src/cli/kit.js";
import type { CliCtx } from "../../src/cli/ctx.js";
import type { MemwatchInstaller } from "../../src/memwatch/launchd.js";
import { initKey, mintToken, setSecretDirForTests } from "../../src/mode/token.js";
import { makeHome } from "../helpers.js";

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

const cwd0 = process.cwd();
let home: string, tmp: string, bin: string, saved: string | undefined, savedMode: string | undefined;
beforeEach(() => {
  home = makeHome(); process.chdir(home); // assertNotWorker cwd'ye de bakar (çalışan worktree'sinde koşabilir)
  tmp = mkdtempSync(join(tmpdir(), "vlad-mw-cli-"));
  saved = process.env.VLAD_TASK_ID; delete process.env.VLAD_TASK_ID;
  savedMode = process.env.VLAD_MODE_TOKEN; delete process.env.VLAD_MODE_TOKEN;
  setSecretDirForTests(join(tmp, "secret"));
  bin = join(tmp, "dist", "bin", "memwatch");
  mkdirSync(join(tmp, "dist", "bin"), { recursive: true });
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
});
afterEach(() => {
  process.chdir(cwd0);
  rmSync(tmp, { recursive: true, force: true });
  setSecretDirForTests(null);
  if (saved !== undefined) process.env.VLAD_TASK_ID = saved;
  if (savedMode !== undefined) process.env.VLAD_MODE_TOKEN = savedMode;
});

async function cli(args: string[], deps: MemwatchCliDeps = {}): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = [], e: string[] = [];
  const sink = (b: string[]) => new Writable({ write(c, _e, cb) { b.push(String(c)); cb(); } });
  const ctx: CliCtx = { cliPath: join(tmp, "dist", "cli.js"), argv: ["node", "vlad", ...args], stdout: sink(o), stderr: sink(e), exit: (c) => { throw new Exit(c); }, env: {} };
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  registerMemwatch(program, createKit(ctx), { platform: "darwin", isTTY: () => true, statePath: join(tmp, "memwatch.json"), ...deps });
  let code = 0;
  try { await program.parseAsync(ctx.argv); } catch (x) { if (x instanceof Exit) code = x.code; else throw x; }
  return { code, out: o.join(""), err: e.join("") };
}

const fakeInstaller = (calls: unknown[]): MemwatchInstaller => ({
  install: async (c) => { calls.push(["install", c]); return ["kuruldu"]; },
  uninstall: async () => { calls.push(["uninstall"]); return ["kaldırıldı"]; },
  status: async () => ({ installed: true, running: true, detail: "çalışıyor" }),
});

describe("vlad top", () => {
  it("runs `<dist>/bin/memwatch top` with passthrough flags and its exit code", async () => {
    const calls: string[][] = [];
    const r = await cli(["top", "--json"], { spawn: (b, a) => { calls.push([b, ...a]); return 0; } });
    expect(r.code, r.err).toBe(0);
    expect(calls).toEqual([[bin, "top", "--json"]]);
    await cli(["top", "--once", "--interval", "5"], { spawn: (b, a) => { calls.push([b, ...a]); return 0; } });
    expect(calls[1]).toEqual([bin, "top", "--once", "--interval", "5"]);
    expect((await cli(["top"], { spawn: () => 3 })).code).toBe(3);
  });
  it("explains how to build when the binary is missing", async () => {
    rmSync(bin);
    const r = await cli(["top"], { spawn: () => 0 });
    expect(r.code).toBe(1);
    expect(r.err).toContain("memwatch ikilisi yok");
    expect(r.err).toContain("npm run build:native");
  });
});

describe("vlad memwatch install / uninstall / status", () => {
  it("install: refuses without TTY, off macOS, on a worker and without the mode token; installs the binary path otherwise", async () => {
    const calls: unknown[] = [];
    const inst = fakeInstaller(calls);
    expect((await cli(["memwatch", "install"], { installer: inst, isTTY: () => false })).err).toContain("TTY");
    expect((await cli(["memwatch", "install"], { installer: inst, platform: "linux" })).err).toContain("macOS");
    initKey(); // anahtar etkin, belirteç yok
    process.env.VLAD_TASK_ID = "T20990101-01";
    try { expect((await cli(["memwatch", "install"], { installer: inst })).code).toBe(1); } finally { delete process.env.VLAD_TASK_ID; }
    expect((await cli(["memwatch", "install"], { installer: inst })).err).toContain("VLAD_MODE_TOKEN");
    expect(calls).toEqual([]);
    process.env.VLAD_MODE_TOKEN = mintToken(60_000);
    const r = await cli(["memwatch", "install", "--json"], { installer: inst });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ installed: true });
    expect(calls).toEqual([["install", { binary: realpathSync(bin), path: process.env.PATH ?? "" }]]);
    calls.length = 0;
    process.env.VLAD_MODE_TOKEN = mintToken(60_000);
    expect((await cli(["memwatch", "uninstall"], { installer: inst })).code).toBe(0);
    expect(calls).toEqual([["uninstall"]]);
  });

  it("install refuses when the binary has not been built", async () => {
    initKey();
    process.env.VLAD_MODE_TOKEN = mintToken(60_000);
    rmSync(bin);
    const r = await cli(["memwatch", "install"], { installer: fakeInstaller([]) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("memwatch ikilisi yok");
  });

  it("status shows the service and the last daemon sample (read-only, no token needed)", async () => {
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(tmp, "memwatch.json"), JSON.stringify({ v: 1, updated: now, pid: 9, interval_secs: 10, rss_bytes: 3 * 1024 * 1024,
      last: { ts: now, level: "warn", reasons: ["boş %15 < %20"], system: { total_bytes: 1, free_pct: 15, pressure: "normal", swap_total_bytes: 0, swap_used_bytes: 0 }, vlad_bytes: 0, groups: [] }, history: [], alerts: {} }));
    const j = JSON.parse((await cli(["memwatch", "status", "--json"], { installer: fakeInstaller([]) })).out);
    expect(j.service).toMatchObject({ installed: true, running: true });
    expect(j.state).toMatchObject({ fresh: true, level: "warn", rss_bytes: 3 * 1024 * 1024 });
    const t = (await cli(["memwatch", "status"], { installer: fakeInstaller([]) })).out;
    expect(t).toContain("servis: çalışıyor");
    expect(t).toContain("son örnek: warn");
    expect(t).toContain("daemon RSS 3.0 MiB");
    const none = (await cli(["memwatch", "status"], { installer: fakeInstaller([]), statePath: join(tmp, "yok.json") })).out;
    expect(none).toContain("durum dosyası yok ya da bayat");
  });
});
