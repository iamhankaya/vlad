import { renameSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maint } from "../../src/agent/maintenance.js";
import { makePing } from "../../src/agent/ops/ping.js";
import { recoverSelfUpdate, scriptRun, startupRecover, type ScriptDeps } from "../../src/agent/ops/script.js";
import type { AgentEnv } from "../../src/agent/ops/env.js";
import { killTreeWait, type KillDeps } from "../../src/agent/proc.js";
import { scriptPlanId } from "../../src/agent/scripts/manifest.js";
import type { Os, ScriptEntry } from "../../src/fleet/types.js";
import { scriptRepo, type Fixture } from "./script-fixture.js";

// T20261112-05: agent bakım/kurtarma bulguları F-vlad-272/274/275/278. Hepsi geçici dizinde, sahte rename/taskkill ile.

const OS: Os = process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin";
const posix = it.skipIf(process.platform === "win32");
const made: string[] = [];
const fixtures: Fixture[] = [];
beforeEach(() => maint.reset());
afterEach(() => { maint.reset(); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); for (const f of fixtures.splice(0)) rmSync(f.dir, { recursive: true, force: true }); });
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "vlad-am-"))); made.push(d); return d; };

/** yarım güncelleme: işaret + node_modules-old (ESKI) + yarım node_modules (YENI) */
function halfUpdated(dir: string) {
  writeFileSync(join(dir, ".vlad-npm-ci-running"), "");
  mkdirSync(join(dir, "node_modules-old")); writeFileSync(join(dir, "node_modules-old", "f"), "ESKI");
  mkdirSync(join(dir, "node_modules")); writeFileSync(join(dir, "node_modules", "f"), "YENI");
}
/** ilk n rename çağrısı EBUSY ile patlar */
const flaky = (n: number) => { let c = 0; return (a: string, b: string) => { if (c++ < n) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); renameSync(a, b); }; };


describe("F-vlad-275: recoverSelfUpdate sonucu bildirir", () => {
  it("işaret yok → true; başarılı geri yükleme → true", () => {
    const d = tmp();
    expect(recoverSelfUpdate(d)).toBe(true);
    halfUpdated(d);
    expect(recoverSelfUpdate(d)).toBe(true);
    expect(readFileSync(join(d, "node_modules", "f"), "utf8")).toBe("ESKI");
    expect(existsSync(join(d, ".vlad-npm-ci-running"))).toBe(false);
  });
  it("rename EBUSY → false ve işaret kalır", () => {
    const d = tmp(); halfUpdated(d);
    expect(recoverSelfUpdate(d, flaky(99))).toBe(false);
    expect(existsSync(join(d, ".vlad-npm-ci-running"))).toBe(true);
  });
});

describe("F-vlad-275: scriptRun geri yükleme başarısızsa bakım bayrağını kaldırmaz", () => {
  function setup(body: string, d: Partial<ScriptDeps>) {
    const f = scriptRepo(OS, "x", body, { class: "write", selfUpdate: true });
    fixtures.push(f);
    const deps: ScriptDeps = { home: f.dir, platform: OS, machine: "win", roots: [], stateDir: tmp(), env: { PATH: process.env.PATH ?? "" }, retryMs: 30, warn: () => {}, ...d };
    const approval = { planId: scriptPlanId({ machine: "win", name: "x", platform: OS, sha256: f.entry.sha256, params: {} }) };
    return { f, deps, args: { name: "x", approval } };
  }
  posix("betik işaret bırakıp çıkar, rename 2 kez EBUSY: bayrak açık kalır, sonra kurtarılınca kalkar", async () => {
    const body = `cd "$VLAD_REPO"\ntouch .vlad-npm-ci-running\nmv node_modules node_modules-old\nmkdir node_modules\necho YENI > node_modules/f\nexit 1\n`;
    const { f, deps, args } = setup(body, { rename: flaky(3) });
    mkdirSync(join(f.dir, "node_modules")); writeFileSync(join(f.dir, "node_modules", "f"), "ESKI");
    await scriptRun(args, deps, { opId: "op-1" });
    expect(maint.on, "yarım node_modules ile op kabul edilmemeli").toBe(true);
    expect(existsSync(join(f.dir, ".vlad-npm-ci-running"))).toBe(true);
    await vi.waitFor(() => expect(maint.on).toBe(false), { timeout: 5_000 });
    expect(readFileSync(join(f.dir, "node_modules", "f"), "utf8")).toBe("ESKI");
  }, 20_000);
});

/** ölü güncelleyiciyi gösteren sidecar (isAlive varsayılanı gerçek pid yoklaması: çok büyük pid yok sayılır) */
const deadPid = () => { const f = join(tmp(), "self-update.pid"); writeFileSync(f, "2147483646"); return f; };
describe("F-vlad-274: açılışta işaret varsa kurtarma; tavan + uyarı + görünürlük", () => {
  it("işaret yok → bakım açılmaz", () => {
    startupRecover(tmp());
    expect(maint.on).toBe(false);
  });
  it("işaret var, kurtarma başarılı → yarım güncelleme geri alınır, bayrak kalkar", () => {
    const d = tmp(); halfUpdated(d);
    startupRecover(d, { pidFile: deadPid() });
    expect(readFileSync(join(d, "node_modules", "f"), "utf8")).toBe("ESKI");
    expect(maint.on).toBe(false);
  });
  it("işaret var, kurtarma başarısız → bakımda kalır, yeniden dener, sonunda kalkar", async () => {
    const d = tmp(); halfUpdated(d);
    startupRecover(d, { pidFile: deadPid(), rename: flaky(3), everyMs: 20, warn: () => {} });
    expect(maint.on).toBe(true);
    expect(maint.snapshot().reason).toBe("recovery");
    await vi.waitFor(() => expect(maint.on).toBe(false), { timeout: 5_000 });
    expect(readFileSync(join(d, "node_modules", "f"), "utf8")).toBe("ESKI");
  });
  it("tavan aşılınca bir kez uyarı yazılır ve durum 'stuck' olur (ping'te görünür); yeniden denemeye devam", async () => {
    const d = tmp(); halfUpdated(d);
    const warns: string[] = [];
    startupRecover(d, { pidFile: deadPid(), rename: flaky(99), everyMs: 10, maxTries: 3, warn: (m) => warns.push(m) });
    await vi.waitFor(() => expect(maint.snapshot().stuck).toBe(true), { timeout: 5_000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("vlad agent");
    expect(maint.on).toBe(true);
    const env = { self: "win", kind: "worker-agent", startedAt: 0, build: "b", now: () => 1000 } as unknown as AgentEnv;
    const r = await makePing(() => env)() as { maintenance?: { on: boolean; reason: string; stuck: boolean; attempts: number } };
    expect(r.maintenance).toMatchObject({ on: true, reason: "recovery", stuck: true });
    expect(r.maintenance!.attempts).toBeGreaterThanOrEqual(3);
    maint.reset();
  });
});

describe("F-vlad-278: uçuştaki op'lar görünür", () => {
  it("ping bakım dışında maintenance alanı taşımaz; uçuştaki op'lar listelenir", async () => {
    const env = { self: "win", kind: "worker-agent", startedAt: 0, build: "b", now: () => 1000 } as unknown as AgentEnv;
    const idle = await makePing(() => env)() as Record<string, unknown>;
    expect(idle.maintenance).toBeUndefined();
    expect(idle.inflight).toEqual([]);
    maint.begin("op-a", "gate-run");
    const busy = await makePing(() => env)() as { inflight: { opId: string; op: string; ageMs: number }[] };
    expect(busy.inflight).toHaveLength(1);
    expect(busy.inflight[0]).toMatchObject({ opId: "op-a", op: "gate-run" });
    expect(busy.inflight[0]!.ageMs).toBeGreaterThanOrEqual(0);
  });
  it("selfUpdate busy mesajı uçuştaki op adlarını ve opId'lerini söyler", async () => {
    const f = scriptRepo(OS, "x", `echo hi\n`, { class: "write", selfUpdate: true });
    fixtures.push(f);
    const deps: ScriptDeps = { home: f.dir, platform: OS, machine: "win", roots: [], stateDir: tmp(), env: { PATH: process.env.PATH ?? "" } };
    const approval = { planId: scriptPlanId({ machine: "win", name: "x", platform: OS, sha256: f.entry.sha256, params: {} }) };
    maint.begin("op-gate", "gate-run");
    await expect(scriptRun({ name: "x", approval }, deps, { opId: "op-self" })).rejects.toThrow(/gate-run.*op-gate/);
    expect(maint.on).toBe(false);
  });
});

describe("F-vlad-272: killTreeWait Windows yeniden deneme", () => {
  const proc = (o: { exitCode: number | null }) => ({ pid: 4242, exitCode: o.exitCode, signalCode: null, kill: () => true }) as unknown as Parameters<typeof killTreeWait>[0];
  const deps = (calls: string[], code: number | null = 0): KillDeps => ({
    platform: "win32", waitMs: 200, pollMs: 50, sleep: async () => {}, isAlive: () => true,
    spawnTaskkill: async (pid) => { calls.push(`taskkill:${pid}`); return code; },
  });
  it("ağaç öldürme hiç doğrulanmadıysa (ilk taskkill başarısız) kök tutamaç çıksa da false: torunlar yaşıyor olabilir; eski pid'e taskkill YOK", async () => {
    const calls: string[] = [];
    const p = proc({ exitCode: null });
    expect(await killTreeWait(p, deps(calls, 1))).toBe(false); // taskkill erişim reddi; yalnız p.kill()
    (p as { exitCode: number | null }).exitCode = 0; // kök çıktı, torunlar belirsiz
    calls.length = 0;
    expect(await killTreeWait(p, { ...deps(calls), recheck: true })).toBe(false);
    expect(calls).toEqual([]);
  });
  it("taskkill /T başarılı (0) ama kök süre içinde ölmediyse, sonra tutamaç çıkınca yeniden denemede taskkill'siz true", async () => {
    const calls: string[] = [];
    const p = proc({ exitCode: null });
    expect(await killTreeWait(p, deps(calls, 0))).toBe(false); // isAlive hep true → süre doldu
    (p as { exitCode: number | null }).exitCode = 0;
    calls.length = 0;
    expect(await killTreeWait(p, { ...deps(calls), recheck: true })).toBe(true);
    expect(calls).toEqual([]);
  });
  it("kök süreç hâlâ bizim ve ağaç öldürme doğrulanmadı → yeniden denemede taskkill atılır", async () => {
    const calls: string[] = [];
    await killTreeWait(proc({ exitCode: null }), { ...deps(calls), recheck: true });
    expect(calls).toEqual(["taskkill:4242"]);
  });
});

describe("F-vlad-274 P1: açılış kurtarması güncelleyicinin durduğunu doğrular", () => {
  const side = (d: string) => join(d, "self-update.pid");
  it("sidecar yok (eski biçim) → geri alınmaz, bakımda kalır, uyarı", () => {
    const d = tmp(); halfUpdated(d);
    const warns: string[] = [];
    startupRecover(d, { pidFile: side(tmp()), rename: renameSync, everyMs: 10_000, warn: (m) => warns.push(m) });
    expect(maint.on).toBe(true);
    expect(readFileSync(join(d, "node_modules", "f"), "utf8")).toBe("YENI");
    expect(existsSync(join(d, ".vlad-npm-ci-running"))).toBe(true);
    expect(warns.join("\n")).toMatch(/pid/);
  });
  it("sidecar'daki süreç grubu canlı → dokunulmaz (bakımda bekler); ölünce geri alınır ve sidecar silinir", async () => {
    const d = tmp(); halfUpdated(d);
    const pf = side(tmp()); writeFileSync(pf, "4242");
    let alive = true;
    startupRecover(d, { pidFile: pf, isAlive: () => alive, everyMs: 20, warn: () => {} });
    expect(maint.on).toBe(true);
    expect(readFileSync(join(d, "node_modules", "f"), "utf8")).toBe("YENI");
    await new Promise((r) => setTimeout(r, 80));
    expect(readFileSync(join(d, "node_modules", "f"), "utf8"), "canlı güncelleyici varken geri yükleme yarışı olmamalı").toBe("YENI");
    alive = false;
    await vi.waitFor(() => expect(maint.on).toBe(false), { timeout: 5_000 });
    expect(readFileSync(join(d, "node_modules", "f"), "utf8")).toBe("ESKI");
    expect(existsSync(pf)).toBe(false);
  });
  it("sidecar'daki süreç ölü → hemen geri alınır", () => {
    const d = tmp(); halfUpdated(d);
    const pf = side(tmp()); writeFileSync(pf, "4242");
    startupRecover(d, { pidFile: pf, isAlive: () => false });
    expect(maint.on).toBe(false);
    expect(readFileSync(join(d, "node_modules", "f"), "utf8")).toBe("ESKI");
  });
  it("Windows: kök pid ölü olsa da torunlar kanıtlanamaz → geri alınmaz, bakımda kalır + uyarı (stuck görünür olacak)", async () => {
    const d = tmp(); halfUpdated(d);
    const pf = side(tmp()); writeFileSync(pf, "4242");
    const warns: string[] = [];
    startupRecover(d, { pidFile: pf, platform: "win32", isAlive: () => false, everyMs: 10, maxTries: 2, warn: (m) => warns.push(m) });
    expect(maint.on).toBe(true);
    await vi.waitFor(() => expect(maint.snapshot().stuck).toBe(true), { timeout: 5_000 });
    expect(readFileSync(join(d, "node_modules", "f"), "utf8")).toBe("YENI");
    expect(existsSync(join(d, ".vlad-npm-ci-running"))).toBe(true);
    expect(warns.join("\n")).toMatch(/Windows|torun/);
    maint.reset();
  });
  posix("P2: geri alma EBUSY ile başarısız → sidecar silinmez (yeniden başlatmada startupRecover ölü pid görüp tekrar dener); başarılı olunca silinir", async () => {
    const f = scriptRepo(OS, "x", `cd "$VLAD_REPO"\ntouch .vlad-npm-ci-running\nmv node_modules node_modules-old\nmkdir node_modules\nexit 1\n`, { class: "write", selfUpdate: true });
    fixtures.push(f);
    mkdirSync(join(f.dir, "node_modules")); writeFileSync(join(f.dir, "node_modules", "f"), "ESKI");
    const state = tmp();
    const deps: ScriptDeps = { home: f.dir, platform: OS, machine: "win", roots: [], stateDir: state, env: { PATH: process.env.PATH ?? "" }, warn: () => {}, retryMs: 30, rename: flaky(2) };
    const approval = { planId: scriptPlanId({ machine: "win", name: "x", platform: OS, sha256: f.entry.sha256, params: {} }) };
    await scriptRun({ name: "x", approval }, deps, { opId: "op-p2" });
    expect(maint.on).toBe(true);
    expect(existsSync(join(state, "self-update.pid")), "geri alma bitmeden sidecar silinmemeli").toBe(true);
    await vi.waitFor(() => expect(maint.on).toBe(false), { timeout: 5_000 });
    expect(existsSync(join(state, "self-update.pid"))).toBe(false);
    expect(readFileSync(join(f.dir, "node_modules", "f"), "utf8")).toBe("ESKI");
  });
  posix("scriptRun selfUpdate: spawn anında güncelleyici pid'i sidecar'a yazılır, kurtarma bitince silinir", async () => {
    const f = scriptRepo(OS, "x", `cd "$VLAD_REPO"\ncat "$VLAD_STATE_PID_PROBE" 2>/dev/null\nexit 1\n`, { class: "write", selfUpdate: true });
    fixtures.push(f);
    const state = tmp();
    const seen: string[] = [];
    const deps: ScriptDeps = { home: f.dir, platform: OS, machine: "win", roots: [], stateDir: state, env: { PATH: process.env.PATH ?? "" }, warn: () => {}, onUpdaterSpawn: (pid) => seen.push(String(pid)) };
    const approval = { planId: scriptPlanId({ machine: "win", name: "x", platform: OS, sha256: f.entry.sha256, params: {} }) };
    await scriptRun({ name: "x", approval }, deps, { opId: "op-pid" });
    expect(seen).toHaveLength(1);
    expect(existsSync(join(state, "self-update.pid")), "betik bittikten sonra sidecar kalmaz").toBe(false);
  });
});

describe("symlink yedek reddi (güvenlik, düşük)", () => {
  posix("node_modules-old symlink ise geri yüklenmez (false, işaret kalır)", () => {
    const d = tmp(); writeFileSync(join(d, ".vlad-npm-ci-running"), "");
    const target = tmp();
    symlinkSync(target, join(d, "node_modules-old"));
    expect(recoverSelfUpdate(d)).toBe(false);
    expect(existsSync(join(d, ".vlad-npm-ci-running"))).toBe(true);
  });
});
