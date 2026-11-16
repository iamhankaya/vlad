import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApprover, type ApproverCliDeps } from "../../src/cli/groups/approver.js";
import { createKit } from "../../src/cli/kit.js";
import type { CliCtx } from "../../src/cli/ctx.js";
import { createLaunchdInstaller, type Launchctl } from "../../src/approver/launchd.js";
import { newId } from "../../src/approver/request.js";
import { createStore } from "../../src/approver/store.js";
import type { PendingRecord } from "../../src/approver/types.js";
import { approverDir, initKey, mintToken, setSecretDirForTests } from "../../src/mode/token.js";
import { makeHome } from "../helpers.js";

const runApprover = vi.fn(async (_d: unknown) => undefined);
vi.mock("../../src/approver/service.js", () => ({ runApprover: (d: unknown) => runApprover(d) }));
vi.mock("../../src/approver/exec.js", () => ({ createExecutor: () => ({ run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) }), defaultExecEnv: () => ({}) }));

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const cwd0 = process.cwd();
let home: string, plistDir: string, calls: string[][], launchResult: Record<string, number>, secret: string;
let outBuf: string[], errBuf: string[], tty: Writable & { isTTY?: boolean; text(): string };

const ID = newId({ bytes: (n) => Buffer.alloc(n, 9) });
let seed = 1;

beforeEach(() => {
  home = makeHome(); process.chdir(home);
  secret = join(home, "secret"); setSecretDirForTests(secret);
  plistDir = join(home, "LaunchAgents"); calls = []; launchResult = {}; outBuf = []; errBuf = []; seed = 1;
  const chunks: string[] = [];
  tty = Object.assign(new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }), { isTTY: true, text: () => chunks.join("") });
  delete process.env.VLAD_MODE_TOKEN;
});
afterEach(() => { process.chdir(cwd0); setSecretDirForTests(null); delete process.env.VLAD_MODE_TOKEN; delete process.env.VLAD_TASK_ID; runApprover.mockClear(); });

let loaded = true; // gerçek launchd gibi: bootout sonrası servis yüklü değil, bootstrap sonrası çalışır
const launchctl: Launchctl = async (a) => {
  calls.push(a);
  if (a[0] === "bootout" && (launchResult.bootout ?? 0) === 0) loaded = false;
  if (a[0] === "bootstrap" && (launchResult.bootstrap ?? 0) === 0) loaded = true;
  if (a[0] === "print" && !loaded) return { code: 113, stdout: "", stderr: "Could not find service" };
  return { code: launchResult[a[0]!] ?? 0, stdout: a[0] === "print" ? "state = running" : "", stderr: "" };
};
const enableKey = () => { initKey(); process.env.VLAD_MODE_TOKEN = mintToken(60_000); };

/** Aynı ağaç: kit + registerApprover(deps). `exit` fırlatır, çıktılar yakalanır. */
async function cli(args: string[], deps: ApproverCliDeps = {}): Promise<{ code: number; out: string; err: string }> {
  outBuf = []; errBuf = [];
  const sink = (buf: string[]) => new Writable({ write(c, _e, cb) { buf.push(String(c)); cb(); } });
  const ctx: CliCtx = { cliPath: join(home, "dist", "cli.js"), argv: ["node", "vlad", "approver", ...args], stdout: sink(outBuf), stderr: sink(errBuf), exit: (c) => { throw new Exit(c); }, env: {} };
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  registerApprover(program, createKit(ctx), { isTTY: () => true, stdout: tty, installer: createLaunchdInstaller({ launchctl, plistDir }), random: { bytes: (n) => Buffer.alloc(n, seed++) }, ...deps });
  let code = 0;
  try { await program.parseAsync(ctx.argv); } catch (e) { if (e instanceof Exit) code = e.code; else throw e; }
  return { code, out: outBuf.join(""), err: errBuf.join("") };
}
const channel = () => JSON.parse(readFileSync(join(approverDir(), "channel.json"), "utf8"));
const pending = (over: Partial<PendingRecord> = {}): PendingRecord => ({ v: 1, id: ID, shortId: ID.slice(0, 8), cid: ID, op: "mode night", argv: ["mode", "night", "--note", "x".repeat(100)], requestedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:05:00.000Z", nonce: "a".repeat(32), respTopic: "vlad-r-secretsecretsecretsecret", digest: "b".repeat(64), ctx: { home: "/h", kb: "/k", cli: "/c" }, keyGen: "c".repeat(16), status: "pending", requester: "vlad", ...over });

describe("approver: install", () => {
  it("TTY yoksa, çalışan oturumunda ve mod belirteci yokken reddeder; hiçbir şey yazılmaz", async () => {
    enableKey();
    expect((await cli(["install"], { isTTY: () => false })).err).toContain("TTY");
    process.env.VLAD_TASK_ID = "T20261116-99";
    expect((await cli(["install"])).code).toBe(1);
    delete process.env.VLAD_TASK_ID;
    delete process.env.VLAD_MODE_TOKEN;
    expect((await cli(["install"])).err).toContain("VLAD_MODE_TOKEN");
    expect(existsSync(approverDir())).toBe(false);
    expect(calls).toEqual([]);
  });

  it("mod anahtarı kapalıyken reddeder", async () => {
    const r = await cli(["install"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("mod belirteci etkin değil");
    expect(existsSync(join(approverDir(), "channel.json"))).toBe(false);
  });

  it("https zorunlu", async () => {
    enableKey();
    expect((await cli(["install", "--server", "http://ntfy.sh"])).err).toContain("https");
    expect((await cli(["install", "--server", "bozuk"])).err).toContain("https");
  });

  it("başarı: channel.json v1, plist + launchctl, URL yalnız stdout TTY'ye; kit çıktısında konu yok", async () => {
    enableKey();
    const r = await cli(["install"]);
    expect(r.code).toBe(0);
    const ch = channel();
    expect(ch).toMatchObject({ v: 1, server: "https://ntfy.sh" });
    expect(ch.requestTopic).toMatch(/^vlad-q-[a-z2-7]{26}$/);
    expect(existsSync(join(plistDir, "com.vlad.approver.plist"))).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(["bootout", "bootstrap"]);
    expect(tty.text()).toContain(`https://ntfy.sh/${ch.requestTopic}`);
    expect(r.out).not.toContain(ch.requestTopic);
    expect(r.err).not.toContain(ch.requestTopic);
    const plist = readFileSync(join(plistDir, "com.vlad.approver.plist"), "utf8");
    expect(plist).toContain(join(home, "dist", "cli.js"));
    expect(plist).not.toContain(ch.requestTopic);
  });

  it("stdout TTY değilse URL basılmaz ve kurulum yapılmaz (hata)", async () => {
    enableKey();
    tty.isTTY = false;
    const r = await cli(["install"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("stdout");
    expect(existsSync(join(approverDir(), "channel.json"))).toBe(false);
    expect(calls).toEqual([]);
    expect(tty.text()).toBe("");
  });

  it("--json: kurulur ama URL hiçbir yere basılmaz", async () => {
    enableKey();
    tty.isTTY = false;
    const r = await cli(["install", "--json"]);
    expect(r.code).toBe(0);
    const topic = channel().requestTopic;
    expect(r.out + r.err + tty.text()).not.toContain(topic);
    expect(JSON.parse(r.out)).toMatchObject({ installed: true });
  });

  it("bootstrap başarısız: channel.json ve plist geri alınır", async () => {
    enableKey();
    launchResult.bootstrap = 5;
    const r = await cli(["install"]);
    expect(r.code).toBe(1);
    expect(existsSync(join(approverDir(), "channel.json"))).toBe(false);
    expect(existsSync(join(plistDir, "com.vlad.approver.plist"))).toBe(false);
    expect(tty.text()).toBe("");
  });

  it("yeniden kurulum idempotent: aynı konu korunur, sunucu güncellenir", async () => {
    enableKey();
    await cli(["install"]);
    const first = channel().requestTopic;
    await cli(["install", "--server", "https://ntfy.example.org"]);
    expect(channel()).toMatchObject({ requestTopic: first, server: "https://ntfy.example.org" });
  });
});

describe("approver: uninstall", () => {
  it("servisi durdurur, plist ve approver/ silinir; used/ ve mode.key kalır", async () => {
    enableKey();
    await cli(["install"]);
    mkdirSync(join(secret, "used"), { mode: 0o700 }); writeFileSync(join(secret, "used", "1.a"), "1");
    const r = await cli(["uninstall"]);
    expect(r.code).toBe(0);
    expect(existsSync(approverDir())).toBe(false);
    expect(existsSync(join(plistDir, "com.vlad.approver.plist"))).toBe(false);
    expect(existsSync(join(secret, "used", "1.a"))).toBe(true);
    expect(existsSync(join(secret, "mode.key"))).toBe(true);
    expect(calls.map((c) => c[0]).slice(-2)).toEqual(["bootout", "print"]); // bootout, sonra sonlanma doğrulaması
  });
  it("TTY yoksa reddeder", async () => {
    enableKey(); await cli(["install"]);
    expect((await cli(["uninstall"], { isTTY: () => false })).code).toBe(1);
    expect(existsSync(approverDir())).toBe(true);
  });
});

describe("approver: rotate", () => {
  it("yeni konu, bekleyen denied: rotated, servis yeniden başlatılır, yeni URL yalnız TTY'ye", async () => {
    enableKey();
    await cli(["install"]);
    const old = channel().requestTopic; tty.text(); const before = tty.text().length;
    const st = createStore(approverDir()); st.writePending(pending());
    calls = [];
    const r = await cli(["rotate"]);
    expect(r.code).toBe(0);
    const now = channel().requestTopic;
    expect(now).not.toBe(old);
    expect(now).toMatch(/^vlad-q-/);
    expect(tty.text().slice(before)).toContain(now);
    expect(r.out + r.err).not.toContain(now);
    expect(st.readPending()).toBeNull();
    expect(st.readResult(ID)).toMatchObject({ status: "denied", reason: "rotated" });
    expect(calls.map((c) => c[0])).toContain("bootstrap");
  });
  it("önce servis durur (kapanması beklenir), sonra dosyalar yazılır, sonra yeniden kurulur", async () => {
    enableKey();
    await cli(["install"]);
    const old = channel().requestTopic;
    const st = createStore(approverDir()); st.writePending(pending());
    const ev: string[] = [];
    let polls = 0;
    const base = createLaunchdInstaller({ launchctl, plistDir });
    const installer = {
      install: async (c: Parameters<typeof base.install>[0]) => { ev.push(`install:${channel().requestTopic === old ? "old" : "new"}:${st.readPending() ? "pend" : "clear"}`); return base.install(c); },
      uninstall: async () => { ev.push(`uninstall:${channel().requestTopic === old ? "old" : "new"}`); return base.uninstall(); },
      status: async () => { const s = await base.status(); if (ev.includes("uninstall:old") && !ev.includes("stopped")) { polls++; if (polls < 3) return { ...s, running: true }; ev.push("stopped"); } return s; },
    };
    const sleeps: number[] = [];
    const r = await cli(["rotate"], { installer, sleep: async (ms) => { sleeps.push(ms); } });
    expect(r.code).toBe(0);
    expect(ev).toEqual(["uninstall:old", "stopped", "install:new:clear"]);
    expect(sleeps.length).toBeGreaterThan(0);
  });
  it("F-vlad-346(b): servis kapanmazsa mesaj servisin kaldırıldığını ve yeniden kurulumu söyler", async () => {
    enableKey();
    await cli(["install"]);
    const base = createLaunchdInstaller({ launchctl, plistDir });
    const installer = { install: base.install, uninstall: base.uninstall, status: async () => ({ ...(await base.status()), running: true }) };
    const r = await cli(["rotate"], { installer, sleep: async () => undefined });
    expect(r.code).toBe(1);
    expect(r.err).toContain("servis kaldırıldı");
    expect(r.err).toContain("vlad approver install");
  });
  it("çalışmış (executing / sonucu olan) isteği rotated diye ezmez", async () => {
    enableKey();
    await cli(["install"]);
    const st = createStore(approverDir());
    st.writePending(pending({ status: "executing" }));
    const r1 = await cli(["rotate"], { sleep: async () => undefined });
    expect(r1.code).toBe(0);
    expect(st.readResult(ID)).toBeNull();
    expect(st.readPending()?.status).toBe("executing");
    st.writePending(pending());
    st.writeResult({ v: 1, id: ID, status: "done", exitCode: 0, stdout: "ok", stderr: "", finishedAt: "2030-01-01T00:01:00.000Z" });
    await cli(["rotate"], { sleep: async () => undefined });
    expect(st.readResult(ID)).toMatchObject({ status: "done" });
  });
  it("kurulu değilken hata; TTY yoksa reddeder", async () => {
    enableKey();
    expect((await cli(["rotate"])).err).toContain("approver kurulu değil");
    await cli(["install"]);
    expect((await cli(["rotate"], { isTTY: () => false })).err).toContain("TTY");
  });
});

describe("approver: unlock", () => {
  it("kilidi temizler, soğuma kayıtlarını korur; TTY/yetki şart", async () => {
    enableKey();
    await cli(["install"]);
    const st = createStore(approverDir());
    st.writeRate({ v: 1, decisions: ["2030-01-01T00:00:00.000Z"], consecutiveDenied: 3, lockedUntil: "2099-01-01T00:00:00.000Z" });
    expect((await cli(["unlock"], { isTTY: () => false })).code).toBe(1);
    expect(st.readRate().consecutiveDenied).toBe(3);
    expect((await cli(["unlock"])).code).toBe(0);
    expect(st.readRate()).toEqual({ v: 1, decisions: ["2030-01-01T00:00:00.000Z"], consecutiveDenied: 0, lockedUntil: null });
  });
  it("çalışan oturumunda reddeder", async () => {
    enableKey(); await cli(["install"]);
    process.env.VLAD_TASK_ID = "T20261116-99";
    expect((await cli(["unlock"])).code).toBe(1);
  });
});

describe("approver: status / requests / show", () => {
  it("status --json: kurulu değil → bekleyen yok; kurulu → kısa kimlik + kilit; konu/nonce/digest yok", async () => {
    expect(JSON.parse((await cli(["status", "--json"])).out)).toMatchObject({ installed: false, running: false, pending: null, locked: null });
    enableKey(); await cli(["install"]);
    const st = createStore(approverDir());
    st.writePending(pending());
    st.writeRate({ v: 1, decisions: [], consecutiveDenied: 3, lockedUntil: "2099-01-01T00:00:00.000Z" });
    const r = await cli(["status", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ installed: true, running: true, pending: ID.slice(0, 8), locked: "2099-01-01T00:00:00.000Z" });
    for (const secretText of [channel().requestTopic, "vlad-r-", "a".repeat(32), "b".repeat(64)]) expect(r.out).not.toContain(secretText);
  });
  it("status: bozuk rate.json kilitli sayılır (fail-closed gösterim)", async () => {
    enableKey(); await cli(["install"]);
    writeFileSync(join(approverDir(), "rate.json"), "{", { mode: 0o600 });
    expect(JSON.parse((await cli(["status", "--json"])).out).locked).toBe("rate_state_corrupt");
  });
  it("requests --json: bekleyen + sonuçlar, --limit; argv/konu/stdout yok", async () => {
    enableKey(); await cli(["install"]);
    const st = createStore(approverDir());
    st.writePending(pending());
    st.writeResult({ v: 1, id: newId({ bytes: (n) => Buffer.alloc(n, 3) }), status: "done", exitCode: 0, stdout: "GİZLİ-ÇIKTI", stderr: "", finishedAt: "2030-01-01T00:01:00.000Z" });
    const r = await cli(["requests", "--json"]);
    const list = JSON.parse(r.out).requests;
    expect(list.map((x: { status: string }) => x.status)).toEqual(["pending", "done"]);
    for (const bad of ["GİZLİ-ÇIKTI", "xxxxx", "vlad-r-", "a".repeat(32), channel().requestTopic]) expect(r.out).not.toContain(bad);
    expect(JSON.parse((await cli(["requests", "--json", "--limit", "1"])).out).requests).toHaveLength(1);
    expect((await cli(["requests", "--limit", "0"])).code).toBe(1);
  });
  it("requests: kurulu değilken boş liste", async () => {
    expect(JSON.parse((await cli(["requests", "--json"])).out)).toEqual({ requests: [] });
  });
  it("show: kimlik doğrulanır; bekleyen ve sonuç; uzun argüman kırpılır; yoksa hata", async () => {
    enableKey(); await cli(["install"]);
    createStore(approverDir()).writePending(pending());
    expect((await cli(["show", "../etc/passwd"])).err).toContain("geçersiz kimlik");
    const r = JSON.parse((await cli(["show", ID, "--json"])).out);
    expect(r.pending).toMatchObject({ op: "mode night", requester: "vlad", status: "pending" });
    expect(r.pending.argv[3].length).toBeLessThan(70);
    expect(JSON.stringify(r)).not.toContain("a".repeat(32));
    expect((await cli(["show", newId({ bytes: (n) => Buffer.alloc(n, 5) })])).err).toContain("kayıt bulunamadı");
  });
  it("show: bekleyen silindikten sonra sonuç kaydındaki op/argv/requester gösterilir (kırpılı)", async () => {
    enableKey(); await cli(["install"]);
    const rec = { v: 1, id: ID, status: "done", exitCode: 0, stdout: "", stderr: "", finishedAt: "2030-01-01T00:01:00.000Z", op: "mode night", argv: ["mode", "night", "--note", "n".repeat(100)], requester: "vlad-07" };
    createStore(approverDir()).writeResult(rec as never);
    const r = JSON.parse((await cli(["show", ID, "--json"])).out);
    expect(r.result).toMatchObject({ op: "mode night", requester: "vlad-07", status: "done" });
    expect(r.result.argv[3].length).toBeLessThan(70);
  });
  it("çalışan oturumunda reddeder", async () => {
    process.env.VLAD_TASK_ID = "T20261116-99";
    for (const a of [["status"], ["requests"], ["show", ID]]) expect((await cli(a)).code).toBe(1);
  });
});

describe("approver: run", () => {
  it("channel.json yoksa hata; varsa runApprover sabit deps ile çağrılır (store, channel, executor, signal)", async () => {
    enableKey();
    expect((await cli(["run"])).err).toContain("approver kurulu değil");
    expect(runApprover).not.toHaveBeenCalled();
    await cli(["install"]);
    expect((await cli(["run"])).code).toBe(0);
    expect(runApprover).toHaveBeenCalledTimes(1);
    const d = runApprover.mock.calls[0]![0] as Record<string, any>;
    expect(Object.keys(d).sort()).toEqual(["channel", "clock", "executor", "log", "random", "signal", "store"]);
    expect(d.store.dir).toBe(approverDir());
    expect(d.signal.aborted).toBe(false);
    expect(typeof d.channel.publishRequest).toBe("function");
  });
  it("SIGTERM sinyali iptal eder ve dinleyiciler temizlenir", async () => {
    enableKey(); await cli(["install"]);
    const base = process.listenerCount("SIGTERM");
    runApprover.mockImplementationOnce(async (d: any) => { process.emit("SIGTERM"); expect(d.signal.aborted).toBe(true); });
    await cli(["run"]);
    expect(process.listenerCount("SIGTERM")).toBe(base);
  });
});
