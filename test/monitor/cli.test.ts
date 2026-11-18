import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerMonitor, type MonitorCliDeps } from "../../src/cli/groups/monitor.js";
import { createKit } from "../../src/cli/kit.js";
import type { CliCtx } from "../../src/cli/ctx.js";
import { listTasks } from "../../src/tasks/index.js";
import { monitorInstallActions } from "../../src/monitor/install.js";
import { initKey, mintToken, setSecretDirForTests } from "../../src/mode/token.js";
import type { ServiceInstaller } from "../../src/approver/launchd.js";
import { makeHome } from "../helpers.js";

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "spc", n), "utf8"));
const TOKEN = "SECRET-TOKEN-cli";

const cwd0 = process.cwd();
let home: string, stateDir: string, srv: Server, url: string, status: number, body: unknown, saved: string | undefined, savedMode: string | undefined;
beforeEach(async () => {
  home = makeHome(); process.chdir(home);
  saved = process.env.VLAD_TASK_ID; delete process.env.VLAD_TASK_ID;
  savedMode = process.env.VLAD_MODE_TOKEN; delete process.env.VLAD_MODE_TOKEN;
  setSecretDirForTests(join(home, "secret"));
  cpSync(join(__dirname, "..", "..", "roles"), join(home, "roles"), { recursive: true });
  stateDir = mkdtempSync(join(tmpdir(), "vlad-mon-c-"));
  status = 200; body = fx("alerts-critical-firing.json");
  srv = createServer((_q, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  writeFileSync(join(home, "kb", "projects", "p.md"), "---\nslug: p\n---\n");
});
afterEach(async () => {
  process.chdir(cwd0);
  await new Promise<void>((r) => srv.close(() => r()));
  rmSync(stateDir, { recursive: true, force: true });
  setSecretDirForTests(null);
  if (saved !== undefined) process.env.VLAD_TASK_ID = saved;
  if (savedMode !== undefined) process.env.VLAD_MODE_TOKEN = savedMode;
});
const configure = () => writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ monitor: { servers: [{ id: "medialog", agent_url: url, project: "p" }] } }));

async function cli(args: string[], deps: MonitorCliDeps = {}): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = [], e: string[] = [];
  const sink = (b: string[]) => new Writable({ write(c, _e, cb) { b.push(String(c)); cb(); } });
  const ctx: CliCtx = { cliPath: join(home, "dist", "cli.js"), argv: ["node", "vlad", "monitor", ...args], stdout: sink(o), stderr: sink(e), exit: (c) => { throw new Exit(c); }, env: {} };
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  registerMonitor(program, createKit(ctx), { secrets: { read: async () => TOKEN }, stateDir, platform: "darwin", isTTY: () => true, ...deps });
  let code = 0;
  try { await program.parseAsync(ctx.argv); } catch (x) { if (x instanceof Exit) code = x.code; else throw x; }
  return { code, out: o.join(""), err: e.join("") };
}
const fakeInstaller = (calls: string[]): ServiceInstaller => ({
  install: async () => { calls.push("install"); return ["kuruldu"]; },
  uninstall: async () => { calls.push("uninstall"); return ["kaldırıldı"]; },
  status: async () => ({ installed: true, running: false, detail: "yüklü, bir sonraki çekişi bekliyor" }),
});

describe("monitor pull (CLI)", () => {
  it("--json: görev açar, PullResult şekli, çıkış 0, belirteç çıktıda yok", async () => {
    configure();
    const r = await cli(["pull", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.servers[0]).toMatchObject({ id: "medialog", ok: true, fetched: 1 });
    expect(j.servers[0].opened).toHaveLength(1);
    expect(j.errors).toEqual([]);
    expect(listTasks()).toHaveLength(1);
    expect(r.out + r.err).not.toContain(TOKEN);
  });
  it("sunucu hatası (401) → çıkış 1; yapılandırma yok → çıkış 2 ve config hatası", async () => {
    configure();
    status = 401; body = fx("error-401-unauthorized.json").body;
    const r = await cli(["pull", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).errors[0].code).toBe("unauthorized");
    rmSync(join(home, "vlad.config.json"));
    const r2 = await cli(["pull", "--json"]);
    expect(r2.code).toBe(2);
    expect(JSON.parse(r2.out).errors[0].code).toBe("config");
  });
  it("Mac dışı → unsupported_platform, çıkış 2; --dry-run yazmaz; --server bilinmeyen → çıkış 2", async () => {
    configure();
    expect((await cli(["pull", "--json"], { platform: "win32" })).code).toBe(2);
    const d = await cli(["pull", "--dry-run", "--json"]);
    expect(d.code).toBe(0);
    expect(listTasks()).toHaveLength(0);
    expect(existsSync(join(stateDir, "state.json"))).toBe(false);
    expect((await cli(["pull", "--server", "zzz", "--json"])).code).toBe(2);
  });
  it("dış kb kilidi zaman aşımı → kb_busy hatası, çıkış 2 (sözleşme), görev açılmaz, durum yazılmaz", async () => {
    configure();
    writeFileSync(join(home, "kb", ".vlad.lock"), JSON.stringify({ pid: process.ppid, started: Date.now(), token: "baska-surec" })); // yaşayan başka sahip
    const savedT = process.env.VLAD_LOCK_TIMEOUT_MS; process.env.VLAD_LOCK_TIMEOUT_MS = "150";
    try {
      const r = await cli(["pull", "--json"]);
      expect(r.code).toBe(2);
      const j = JSON.parse(r.out);
      expect(j.servers).toEqual([]);
      expect(j.errors).toHaveLength(1);
      expect(j.errors[0]).toMatchObject({ server: null, code: "kb_busy" });
      expect(r.err).toBe("");
    } finally { if (savedT === undefined) delete process.env.VLAD_LOCK_TIMEOUT_MS; else process.env.VLAD_LOCK_TIMEOUT_MS = savedT; }
    expect(listTasks()).toHaveLength(0);
    expect(existsSync(join(stateDir, "state.json"))).toBe(false);
  });
  it("çalışan oturumunda reddedilir", async () => {
    configure();
    process.env.VLAD_TASK_ID = "T20261119-99";
    try { expect((await cli(["pull", "--json"])).code).toBe(1); } finally { delete process.env.VLAD_TASK_ID; }
    expect(listTasks()).toHaveLength(0);
  });
});

describe("monitor status / install / uninstall (CLI)", () => {
  it("status: pull sonrası açık eşleme ve servis durumu; erişilemez ×3 uyarısı", async () => {
    configure();
    await cli(["pull", "--json"]);
    const calls: string[] = [];
    const s = JSON.parse((await cli(["status", "--json"], { installer: fakeInstaller(calls) })).out);
    expect(s.servers[0]).toMatchObject({ id: "medialog", project: "p", fail_streak: 0, unreachable: false });
    expect(s.servers[0].open_tasks).toHaveLength(1);
    expect(s.service).toMatchObject({ installed: true });
    status = 401; body = fx("error-401-unauthorized.json").body;
    for (let i = 0; i < 3; i++) await cli(["pull", "--json"]);
    const t = (await cli(["status"], { installer: fakeInstaller(calls) })).out;
    expect(t).toMatch(/erişilemez ×3/);
  });
  it("install/uninstall: TTY yoksa, çalışanda, Mac dışında, mod belirteci yokken reddeder; hepsi tamamsa kurar", async () => {
    configure();
    const calls: string[] = [];
    const inst = fakeInstaller(calls);
    expect((await cli(["install"], { installer: inst, isTTY: () => false })).err).toContain("TTY");
    expect((await cli(["install"], { installer: inst, platform: "win32" })).err).toContain("macOS");
    initKey(); // anahtar etkin, belirteç yok
    expect((await cli(["install"], { installer: inst })).err).toContain("VLAD_MODE_TOKEN");
    process.env.VLAD_TASK_ID = "T20261119-99";
    try { expect((await cli(["install"], { installer: inst })).code).toBe(1); } finally { delete process.env.VLAD_TASK_ID; }
    expect(calls).toEqual([]);
    process.env.VLAD_MODE_TOKEN = mintToken(60_000);
    const ok = await cli(["install", "--json"], { installer: inst });
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toEqual({ installed: true, steps: ["kuruldu"] });
    expect((await cli(["uninstall", "--json"], { installer: inst })).code).toBe(0);
    expect(calls).toEqual(["install", "uninstall"]);
  });
});

describe("vlad install → monitor servisi", () => {
  const cfg = (home: string) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ monitor: { servers: [{ id: "m", agent_url: "https://x.example", project: "p" }] } }));
  it("yapılandırma yoksa hiçbir şey yapmaz; varsa dry-run söyler, gerçek koşuda kurar; Mac dışında atlar", async () => {
    const calls: string[] = [];
    const base = { home, cli: "/c/cli.js", installer: fakeInstaller(calls), platform: "darwin" as const };
    expect(await monitorInstallActions({ ...base, dryRun: false })).toEqual([]);
    cfg(home);
    expect((await monitorInstallActions({ ...base, dryRun: true }))[0]).toMatch(/kurulur/);
    expect(calls).toEqual([]);
    expect((await monitorInstallActions({ ...base, dryRun: false }))[0]).toMatch(/kuruldu/);
    expect(calls).toEqual(["install"]);
    expect((await monitorInstallActions({ ...base, dryRun: false, platform: "win32" }))[0]).toMatch(/atlandı/);
  });
});
