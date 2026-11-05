import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desktopQueueDir, queueLauncher, secureDir } from "../../src/launcher/desktop-queue.js";
import { buildPosixScript } from "../../src/launcher/posix.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/types.js";

// Real temp dirs only (realpath-checked); POSIX permissions have no meaning on Windows (ACL tests cover it).
describe.skipIf(process.platform === "win32")("desktop queue on POSIX (T20261105-27)", () => {
  let base: string;
  beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-dq-posix-"))); });
  afterEach(() => { expect(base.startsWith(realpathSync(tmpdir()))).toBe(true); rmSync(base, { recursive: true, force: true }); });
  const mkq = (mode = 0o700): string => { const d = join(base, "queue"); mkdirSync(d); chmodSync(d, mode); return d; };
  const env = (q: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ VLAD_DESKTOP_QUEUE: q, ...extra });
  const req = (o: Partial<LaunchRequest> = {}): LaunchRequest => ({
    taskId: "T20261105-99", cwd: base, prompt: "merhaba", env: { VLAD_TASK_ID: "T20261105-99" }, title: "t", ...o,
  });
  const fallback = (calls: string[]): Launcher => ({ launch: async () => { calls.push("fallback"); return { ok: true, method: "tmux", detail: "x" }; } });

  describe("desktopQueueDir", () => {
    it("accepts a 0700 own directory on darwin and linux", () => {
      const q = mkq();
      expect(desktopQueueDir(env(q), "darwin")).toEqual({ dir: q });
      expect(desktopQueueDir(env(q), "linux")).toEqual({ dir: q });
    });
    it("0755 (group/other accessible) directory → warning, no queue", () => {
      const r = desktopQueueDir(env(mkq(0o755)), "darwin");
      expect(r.dir).toBeNull();
      expect((r as { warning?: string }).warning).toMatch(/VLAD_DESKTOP_QUEUE/);
    });
    it("symlink to a good directory → warning, no queue", () => {
      const q = mkq();
      const link = join(base, "link");
      symlinkSync(q, link);
      const r = desktopQueueDir(env(link), "darwin");
      expect(r.dir).toBeNull();
      expect((r as { warning?: string }).warning).toMatch(/VLAD_DESKTOP_QUEUE/);
    });
    it("missing or relative path → warning; unset → silent", () => {
      expect((desktopQueueDir(env(join(base, "yok")), "darwin") as { warning?: string }).warning).toMatch(/VLAD_DESKTOP_QUEUE/);
      expect((desktopQueueDir(env("rel/dir"), "darwin") as { warning?: string }).warning).toMatch(/VLAD_DESKTOP_QUEUE/);
      expect(desktopQueueDir({}, "darwin")).toEqual({ dir: null });
    });
    it("VLAD_TASK_ID set → no queue, no warning", () => {
      expect(desktopQueueDir(env(mkq(), { VLAD_TASK_ID: "T20261105-01" }), "darwin")).toEqual({ dir: null });
    });
  });

  describe("secureDir (POSIX)", () => {
    it("creates a missing directory as 0700 and tightens a loose own directory", () => {
      const d = join(base, "a", "vlad");
      secureDir(d);
      expect(statSync(d).mode & 0o777).toBe(0o700);
      chmodSync(d, 0o755);
      secureDir(d);
      expect(statSync(d).mode & 0o777).toBe(0o700);
    });
    it("refuses a symlink", () => {
      const real = join(base, "real");
      mkdirSync(real);
      const link = join(base, "link");
      symlinkSync(real, link);
      expect(() => secureDir(link)).toThrow(/symlink/);
    });
  });

  describe("buildPosixScript", () => {
    it("clears VLAD_DESKTOP_QUEUE before anything else runs", () => {
      expect(buildPosixScript(req()).split("\n").slice(0, 2)).toEqual(["#!/usr/bin/env bash", "unset VLAD_DESKTOP_QUEUE"]);
    });
  });

  describe("queueLauncher", () => {
    it("writes a v2 request whose scriptSha256 matches the script bytes; script is private (0700 dir, no group/other bits)", async () => {
      const q = mkq();
      const sd = join(base, "vlad");
      const calls: string[] = [];
      const r = await queueLauncher(q, "launch", fallback(calls), sd).launch(req());
      expect(r).toMatchObject({ ok: true, method: "desktop-queue", queued: join(q, "T20261105-99.json") });
      expect(calls).toEqual([]);
      expect(r.script).toBe(join(sd, "T20261105-99.sh"));
      const body = JSON.parse(readFileSync(r.queued!, "utf8"));
      expect(body).toMatchObject({ v: 2, kind: "launch", taskId: "T20261105-99", script: r.script, cwd: base });
      expect(body.scriptSha256).toBe(createHash("sha256").update(readFileSync(r.script!)).digest("hex"));
      expect(typeof body.pid).toBe("number");
      expect(statSync(sd).mode & 0o777).toBe(0o700);
      expect(statSync(r.script!).mode & 0o077).toBe(0);
      expect(readdirSync(q)).toEqual(["T20261105-99.json"]);
    });
    it("script dir that is a symlink → warning + fallback launcher, nothing queued", async () => {
      const q = mkq();
      const real = join(base, "real");
      mkdirSync(real);
      const sd = join(base, "sd");
      symlinkSync(real, sd);
      const calls: string[] = [];
      const r = await queueLauncher(q, "launch", fallback(calls), sd).launch(req());
      expect(calls).toEqual(["fallback"]);
      expect(r.method).toBe("tmux");
      expect(readdirSync(q)).toEqual([]);
    });
    it("queue folder gone/unwritable → fallback launcher", async () => {
      const q = mkq();
      chmodSync(q, 0o500);
      const calls: string[] = [];
      const r = await queueLauncher(q, "resume", fallback(calls), join(base, "vlad")).launch(req());
      chmodSync(q, 0o700);
      if (process.getuid?.() === 0) return; // root ignores mode bits
      expect(calls).toEqual(["fallback"]);
      expect(r.queued).toBeUndefined();
    });
  });
});
