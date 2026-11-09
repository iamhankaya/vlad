import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAINT_FREE_OPS, maint } from "../../src/agent/maintenance.js";
import { scriptRun, type ScriptDeps } from "../../src/agent/ops/script.js";
import { scriptPlanId } from "../../src/agent/scripts/manifest.js";
import { SCRIPT_RESULT_SENTINEL as S, type Os, type ScriptEntry } from "../../src/fleet/types.js";
import { scriptRepo, type Fixture } from "./script-fixture.js";

// selfUpdate + bakım bayrağı (T20261109-10, spec S23/S24): restart yalnız selfUpdate ∧ exit 0 ∧ data.ok true ∧ yeniden başlatma yolu varken.

const OS: Os = process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin";
const posix = it.skipIf(process.platform === "win32");
const made: string[] = [];
const fixtures: Fixture[] = [];
beforeEach(() => maint.reset());
afterEach(() => { maint.reset(); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); for (const f of fixtures.splice(0)) rmSync(f.dir, { recursive: true, force: true }); });

const state = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "vlad-su-"))); made.push(d); return d; };
function setup(body: string, o: Partial<ScriptEntry> = {}, d: Partial<ScriptDeps> = {}) {
  const f = scriptRepo(OS, "x", body, { class: "write", selfUpdate: true, ...o });
  fixtures.push(f);
  const deps: ScriptDeps = { home: f.dir, platform: OS, machine: "win", roots: [], stateDir: state(), env: { PATH: process.env.PATH ?? "" }, ...d };
  const approval = { planId: scriptPlanId({ machine: "win", name: "x", platform: OS, sha256: f.entry.sha256, params: {} }) };
  return { f, deps, args: { name: "x", approval } };
}
const ctx = { opId: "op-su" };

describe("maintenance durumu", () => {
  it("ping/op-status/script-list serbest, diğerleri değil", () => {
    expect([...MAINT_FREE_OPS].sort()).toEqual(["op-status", "ping", "script-list"]);
  });
  it("uçuştaki op sayımı opId başınadır ve kendi opId'si hariç sayılır", () => {
    maint.begin("a"); maint.begin("b"); maint.begin("b");
    expect(maint.others("a")).toBe(1);
    maint.end("b");
    expect(maint.others("a")).toBe(1);
    maint.end("b");
    expect(maint.others("a")).toBe(0);
    maint.end("a");
    expect(maint.inflight()).toBe(0);
  });
});

describe("script-run selfUpdate", () => {
  posix("başarı (exit 0, data.ok true) + yeniden başlatma yolu → restart 'scheduled', kanca bir kez, bayrak açık kalır", async () => {
    let n = 0;
    const { deps, args } = setup(`echo '${S} {"ok":true,"summary":"u"}'\n`, {}, { restart: () => { n++; } });
    const r = await scriptRun(args, deps, ctx);
    expect(r).toMatchObject({ exit: 0, restart: "scheduled", data: { ok: true } });
    expect(n).toBe(1);
    expect(maint.on, "yeniden başlatma bekleyen Agent yeni op almamalı").toBe(true);
  });
  posix("başarı ama yeniden başlatma yolu yok → restart alanı yok, bayrak kalkar", async () => {
    const { deps, args } = setup(`echo '${S} {"ok":true}'\n`);
    const r = await scriptRun(args, deps, ctx);
    expect(r.restart).toBeUndefined();
    expect(maint.on).toBe(false);
  });
  posix("data.ok false → restart yok, kanca çağrılmaz, bayrak kalkar", async () => {
    let n = 0;
    const { deps, args } = setup(`echo '${S} {"ok":false}'\n`, {}, { restart: () => { n++; } });
    expect((await scriptRun(args, deps, ctx)).restart).toBeUndefined();
    expect(n).toBe(0);
    expect(maint.on).toBe(false);
  });
  posix("changed:false ve çalışan süreç diskteki dist ile aynı derlemede → gereksiz yeniden başlatma yok, bayrak kalkar", async () => {
    const { f, deps, args } = setup(`echo '${S} {"ok":true,"changed":false}'\n`, {}, { restart: () => { throw new Error("çağrılmamalı"); }, runningBuildHead: "abc123" });
    mkdirSync(join(f.dir, "dist")); writeFileSync(join(f.dir, "dist", ".build-head"), "abc123");
    const r = await scriptRun(args, deps, ctx);
    expect([r.restart, r.data?.ok]).toEqual([undefined, true]);
    expect(maint.on).toBe(false);
  });
  posix("changed:false AMA çalışan süreç eski derlemede (önceki yeniden başlatma yardımcısı başarısız oldu) → yeniden başlatma yine zamanlanır", async () => {
    let n = 0;
    const { f, deps, args } = setup(`echo '${S} {"ok":true,"changed":false}'\n`, {}, { restart: () => { n++; }, runningBuildHead: "eski" });
    mkdirSync(join(f.dir, "dist")); writeFileSync(join(f.dir, "dist", ".build-head"), "yeni");
    const r = await scriptRun(args, deps, ctx);
    expect([r.restart, n]).toEqual(["scheduled", 1]);
  });
  posix("changed:false ve çalışan derleme bilinmiyor (damga yok) → yeniden başlatma uygun sayılır", async () => {
    let n = 0;
    const { f, deps, args } = setup(`echo '${S} {"ok":true,"changed":false}'\n`, {}, { restart: () => { n++; } });
    mkdirSync(join(f.dir, "dist")); writeFileSync(join(f.dir, "dist", ".build-head"), "yeni");
    expect((await scriptRun(args, deps, ctx)).restart).toBe("scheduled");
    expect(n).toBe(1);
  });
  posix("data.ok 'true' (dize) ya da yok → restart yok", async () => {
    for (const j of ['{"ok":"true"}', '{"summary":"x"}']) {
      const { deps, args } = setup(`echo '${S} ${j}'\n`, {}, { restart: () => { throw new Error("çağrılmamalı"); } });
      expect((await scriptRun(args, deps, ctx)).restart, j).toBeUndefined();
    }
  });
  posix("exit≠0 (sentinel ok:true olsa da) → restart yok", async () => {
    const { deps, args } = setup(`echo '${S} {"ok":true}'\nexit 2\n`, {}, { restart: () => { throw new Error("çağrılmamalı"); } });
    const r = await scriptRun(args, deps, ctx);
    expect([r.exit, r.restart]).toEqual([2, undefined]);
    expect(maint.on).toBe(false);
  });
  posix("selfUpdate olmayan betik hiçbir zaman restart/bayrak üretmez", async () => {
    const { deps, args } = setup(`echo '${S} {"ok":true}'\n`, { selfUpdate: false }, { restart: () => { throw new Error("çağrılmamalı"); } });
    let during = true;
    const r = await scriptRun(args, deps, ctx);
    during = maint.on;
    expect([r.restart, during]).toEqual([undefined, false]);
  });
  posix("betik sürerken bayrak açık; bitince (başarısızsa) kapalı", async () => {
    const { deps, args } = setup(`sleep 0.3\necho '${S} {"ok":false}'\n`);
    const p = scriptRun(args, deps, ctx);
    await new Promise((r) => setTimeout(r, 100));
    expect(maint.on).toBe(true);
    await p;
    expect(maint.on).toBe(false);
  });
  posix("uçuşta başka op varsa busy [maintenance]; bayrak açılmaz, betik koşmaz", async () => {
    const { deps, args } = setup(`echo '${S} {"ok":true}'\n`);
    maint.begin("baska-op");
    const e = await scriptRun(args, deps, ctx).then(() => null, (x: Error & { code?: string }) => x);
    expect(e).toMatchObject({ code: "busy" });
    expect(e!.message).toContain("[maintenance]");
    expect(maint.on).toBe(false);
  });
  posix("betik fırlatırsa (ör. zaman aşımı değil, başlatma hatası) bayrak kalkar", async () => {
    const { deps, args } = setup("x\n", {}, {});
    deps.stateDir = "/dev/null/yok"; // ensurePrivateDir fırlatır
    await scriptRun(args, deps, ctx).catch(() => undefined);
    expect(maint.on).toBe(false);
  });
});
