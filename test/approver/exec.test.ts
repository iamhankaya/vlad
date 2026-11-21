import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecutor, defaultExecEnv } from "../../src/approver/exec.js";
import type { Ctx } from "../../src/approver/types.js";
import { IS_WIN } from "../support/platform.js";

// Windows: işletim sistemi çocuk sürece sistem değişkenlerini kendisi ekler (SYSTEMROOT, USERPROFILE, TEMP…); servis env'inden sızmış sayılmaz.
const OS_INJECTED = IS_WIN ? /^(HOMEDRIVE|HOMEPATH|LOGONSERVER|SYSTEMDRIVE|SYSTEMROOT|TEMP|TMP|USERDOMAIN|USERDOMAIN_ROAMINGPROFILE|USERNAME|USERPROFILE|WINDIR|COMSPEC|PATHEXT|OS|NUMBER_OF_PROCESSORS|COMPUTERNAME|APPDATA|LOCALAPPDATA|ALLUSERSPROFILE|PUBLIC|DRIVERDATA|SESSIONNAME)$/i : /^$/;

// approver: exec (T20261116-06 U4). Gerçek alt süreç, sahte "cli" (test/support/approver-exec-fixture.mjs); zamanlayıcılar kısa değerlerle enjekte edilir.
const FIXTURE = join(import.meta.dirname, "..", "support", "approver-exec-fixture.mjs");
let home: string, ctx: Ctx;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "vlad-exec-"))); ctx = { home, kb: join(home, "kb"), cli: FIXTURE }; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

describe("approver: defaultExecEnv", () => {
  it("yalnız izinli beş anahtar", () => {
    const e = defaultExecEnv({ path: "/p", home: "/h", vladHome: "/v", token: "VMT2.x" });
    expect(e).toEqual({ PATH: "/p", HOME: "/h", VLAD_HOME: "/v", LANG: "en_US.UTF-8", VLAD_MODE_TOKEN: "VMT2.x" });
  });
});

describe("approver: defaultExecEnv belirteç yalnız verilirse", () => {
  it("boş token: VLAD_MODE_TOKEN env'e girmez (korunmayan komut belirteç görmez)", () => {
    const e = defaultExecEnv({ path: "/p", home: "/h", vladHome: "/v", token: "" });
    expect(Object.keys(e).sort()).toEqual(["HOME", "LANG", "PATH", "VLAD_HOME"]);
  });
});

describe("approver: ctx.kb çocuğa aktarılır", () => {
  it("defaultExecEnv kb verilince VLAD_KB_DIR ekler (yalnız bu değer)", () => {
    const e = defaultExecEnv({ path: "/p", home: "/h", vladHome: "/v", token: "t", kb: "/kb" });
    expect(e.VLAD_KB_DIR).toBe("/kb"); expect(Object.keys(e)).toHaveLength(6);
  });
  it("çocuk, servisin bildirdiği kb'yi görür (ana ortamdaki VLAD_KB_DIR değil)", async () => {
    const saved = process.env.VLAD_KB_DIR; process.env.VLAD_KB_DIR = "/baska/kb";
    try {
      const r = await createExecutor().run(["env"], "t", ctx);
      expect((JSON.parse(r.stdout) as { env: Record<string, string> }).env.VLAD_KB_DIR).toBe(ctx.kb);
    } finally { if (saved === undefined) delete process.env.VLAD_KB_DIR; else process.env.VLAD_KB_DIR = saved; }
  });
});

describe("approver: createExecutor", () => {
  it("argv, token ve temiz env ile çalışır; ortam sızmaz", async () => {
    const saved = { t: process.env.VLAD_TASK_ID, u: process.env.USERPROFILE, n: process.env.NODE_OPTIONS, s: process.env.SECRET_X };
    Object.assign(process.env, { VLAD_TASK_ID: "T1", USERPROFILE: "/u", SECRET_X: "s" });
    try {
      const r = await createExecutor().run(["env", "--a", "b"], "VMT2.tok", ctx);
      expect(r.exitCode).toBe(0); expect(r.timedOut).toBe(false);
      const o = JSON.parse(r.stdout) as { argv: string[]; env: Record<string, string>; cwd: string };
      expect(o.argv).toEqual(["--a", "b"]);
      expect(Object.keys(o.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING" && !OS_INJECTED.test(k)).sort()).toEqual(["HOME", "LANG", "PATH", "VLAD_HOME", "VLAD_KB_DIR", "VLAD_MODE_TOKEN"]);
      expect(o.env).toMatchObject({ HOME: userInfo().homedir, VLAD_HOME: home, VLAD_KB_DIR: ctx.kb, VLAD_MODE_TOKEN: "VMT2.tok" });
      expect(o.cwd).toBe(home);
    } finally {
      for (const [k, v] of [["VLAD_TASK_ID", saved.t], ["USERPROFILE", saved.u], ["NODE_OPTIONS", saved.n], ["SECRET_X", saved.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it("envExtra yalnız deps'ten eklenir", async () => {
    const r = await createExecutor().run(["env"], "t", ctx, { envExtra: { FOO: "bar" } });
    expect((JSON.parse(r.stdout) as { env: Record<string, string> }).env.FOO).toBe("bar");
  });

  it("sıfırdan farklı çıkış kodu ve stderr döner", async () => {
    const r = await createExecutor().run(["exit", "7"], "t", ctx);
    expect(r).toMatchObject({ exitCode: 7, stderr: "hata metni", timedOut: false });
  });

  it("olmayan cli: fırlatmaz, exitCode null", async () => {
    const r = await createExecutor().run(["env"], "t", { ...ctx, cli: join(home, "yok.mjs") });
    expect(r.exitCode).not.toBe(0);
  });

  // Windows'ta atlanır: süreç grubu (detached + process.kill(-pid)) ve SIGTERM/SIGKILL semantiği POSIX'e özgü; onay servisi Mac'te çalışır.
  it.skipIf(IS_WIN)("zaman aşımı: SIGTERM'i yok sayan süreç ve torunu grup SIGKILL ile ölür", async () => {
    const r = await createExecutor({ timeoutMs: 400, killGraceMs: 200 }).run(["stubborn"], "t", ctx);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    const pid = Number(/pid (\d+)/.exec(r.stdout)![1]);
    expect(await gone(pid)).toBe(true);
  });

  it("çıktı sınırı: bellekte ve sonuçta ≤ maxOutputBytes", async () => {
    const r = await createExecutor({ maxOutputBytes: 1000 }).run(["flood", "500000"], "t", ctx);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBe(1000); expect(r.stderr.length).toBe(1000);
  });

  // Windows'ta atlanır: süreç grubu öldürme POSIX'e özgü (yukarıdaki gibi).
  it.skipIf(IS_WIN)("signal iptali grubu öldürür ve aborted döner", async () => {
    const ac = new AbortController();
    const p = createExecutor({ killGraceMs: 200 }).run(["hang"], "t", ctx, { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const r = await p;
    expect(r).toMatchObject({ aborted: true, timedOut: false, exitCode: null });
  });
});
