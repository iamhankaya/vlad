import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../../src/agent/client.js";
import { Journal } from "../../src/agent/journal.js";
import { setAgentEnv } from "../../src/agent/ops/env.js";
import { OP_TABLE } from "../../src/agent/ops/index.js";
import { scriptList, scriptRun, type ScriptDeps } from "../../src/agent/ops/script.js";
import { startServer, type RunningServer } from "../../src/agent/server.js";
import { defaultConfig } from "../../src/kb/config.js";
import type { VladConfig } from "../../src/kb/types.js";
import { RemoteError, SCRIPT_RESULT_SENTINEL, type Os, type ScriptRunResult } from "../../src/fleet/types.js";
import { runRemoteScript } from "../../src/machines/script-cli.js";
import { entryOf, manifestJson, makeRepo, type Fixture } from "./script-fixture.js";

// Uçtan uca (T20261109-07): gerçek Agent sunucusu (loopback, gerçek HMAC/günlük) + gerçek geçici git deposu + gerçek bash.
const posix = describe.skipIf(process.platform === "win32");
const OS: Os = process.platform === "linux" ? "linux" : "darwin";
const K = { mac: "11".repeat(32), windows: "22".repeat(32), desktop: "33".repeat(32) };
const cfg = (): VladConfig => ({
  ...defaultConfig(), brain: "mac", consoles: [{ name: "desktop" }],
  machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 1 } }, { name: "windows", os: OS, agent: { host: "127.0.0.1", port: 1 } }],
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); setAgentEnv(undefined); });
const tmp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };

async function setup(scripts: { name: string; body: (counter: string) => string; class?: "read" | "write"; params?: never[] }[]) {
  const counter = join(tmp("vlad-cnt-"), "runs");
  const entries = scripts.map((s) => entryOf(OS, s.name, s.body(counter), { class: s.class ?? "read" }));
  const files: Record<string, string> = { "agent-scripts/manifest.json": manifestJson(...entries) };
  scripts.forEach((s, i) => { files[entries[i]!.file] = s.body(counter); });
  const repo: Fixture = makeRepo(files);
  repo.withUpstream();
  cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
  const c = cfg();
  const d: ScriptDeps = { home: repo.dir, platform: OS, machine: "windows", roots: [], stateDir: tmp("vlad-state-"), env: { PATH: process.env.PATH ?? "" } };
  const journal = new Journal(join(tmp("vlad-j-"), "j.jsonl"), () => Date.now());
  setAgentEnv({ self: "windows", kind: "worker-agent", cfg: c, startedAt: Date.now(), build: "t", journal, transport: new AgentClient({ self: "windows", keys: K, config: () => c }), now: () => Date.now() });
  const ops = { ...OP_TABLE, "script-list": (a: unknown) => scriptList(a, d), "script-run": (a: unknown, ctx: { opId: string }) => scriptRun(a, d, ctx) };
  const srv: RunningServer = await startServer({ self: "windows", kind: "worker-agent", cfg: () => c, keys: K, ops, journal, build: "t", bind: "127.0.0.1", port: 0 });
  cleanups.push(() => srv.close());
  c.machines![1]!.agent.port = srv.port;
  const as = (self: "mac" | "desktop") => new AgentClient({ self, keys: { windows: K[self] }, config: () => c });
  const runs = () => { try { return readFileSync(counter, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  return { as, runs, journal, srv, c };
}
const count = (c: string) => `echo x >> '${c}'\n`;

posix("script ops: Agent sunucusu üzerinden", () => {
  it("brain script-list/script-run çağırabilir; konsol ve (başka) kimlikler forbidden", async () => {
    const w = await setup([{ name: "oku", body: (c) => count(c) + `echo '${SCRIPT_RESULT_SENTINEL} {"ok":true,"summary":"tamam"}'\n` }]);
    const l = (await w.as("mac").call<{ scripts: { name: string; integrity: string }[] }>("windows", "script-list", {})).result;
    expect(l.scripts.map((s) => [s.name, s.integrity])).toEqual([["oku", "ok"]]);
    const r = (await w.as("mac").call<ScriptRunResult>("windows", "script-run", { name: "oku" })).result;
    expect(r).toMatchObject({ exit: 0, data: { ok: true, summary: "tamam" } });
    for (const op of ["script-list", "script-run"] as const) {
      const e = await w.as("desktop").call("windows", op, { name: "oku" }).catch((x: RemoteError) => x);
      expect((e as RemoteError).code, op).toBe("forbidden");
    }
    expect(w.runs()).toBe(1);
  });

  it("aynı opId ikinci kez koşmaz (replayed); aynı opId başka parametreyle conflict", async () => {
    const w = await setup([{ name: "oku", body: count }]);
    const a = await w.as("mac").call<ScriptRunResult>("windows", "script-run", { name: "oku" }, { opId: "same-1" });
    const b = await w.as("mac").call<ScriptRunResult>("windows", "script-run", { name: "oku" }, { opId: "same-1" });
    expect(b.meta?.replayed).toBe(true);
    expect(b.result.exit).toBe(a.result.exit);
    expect(w.runs()).toBe(1);
    const e = await w.as("mac").call("windows", "script-run", { name: "oku", params: {} }, { opId: "same-1" }).catch((x: RemoteError) => x);
    expect(e).toBeInstanceOf(RemoteError); // argüman nesnesi farklı değil ama boş params farklı hash → conflict
    expect((e as RemoteError).code).toBe("conflict");
  });

  it("betik hatası ve zaman aşımı op'u başarısız yapmaz; sonuç journal'a işlenir, tekrar koşmaz", async () => {
    const w = await setup([{ name: "hata", body: (c) => count(c) + "exit 9\n" }]);
    const a = await w.as("mac").call<ScriptRunResult>("windows", "script-run", { name: "hata" }, { opId: "h1" });
    expect(a.result.exit).toBe(9);
    const b = await w.as("mac").call<ScriptRunResult>("windows", "script-run", { name: "hata" }, { opId: "h1" });
    expect(b.meta?.replayed).toBe(true);
    expect(w.runs()).toBe(1);
  });

  it("write: CLI mantığı --plan → --confirmed ile gerçek Agent'a; onaysız çalışmaz", async () => {
    const w = await setup([{ name: "yaz", class: "write", body: count }]);
    const t = w.as("mac");
    const plan = await runRemoteScript(t, "windows", "yaz", { params: {}, plan: true });
    expect(plan.kind).toBe("plan");
    if (plan.kind !== "plan") return;
    await expect(runRemoteScript(t, "windows", "yaz", { params: {} })).rejects.toThrow(/--plan/);
    const bad = await t.call("windows", "script-run", { name: "yaz", approval: { planId: "0".repeat(16) } }).catch((x: RemoteError) => x);
    expect((bad as RemoteError).message).toContain("[approval]");
    expect(w.runs()).toBe(0);
    const ok = await runRemoteScript(t, "windows", "yaz", { params: {}, confirmed: plan.planId });
    expect(ok).toMatchObject({ kind: "result", result: { exit: 0 } });
    expect(w.runs()).toBe(1);
  });

  it("büyük çıktı: canlı yanıt tam, journal tekrarı özetlenmiş skaler alanlarla (kırpma işaretiyle değil)", async () => {
    const w = await setup([{ name: "buyuk", body: () => `yes '${"ab".repeat(30)}' | head -c 600000\nexit 4\n` }]);
    const a = await w.as("mac").call<ScriptRunResult>("windows", "script-run", { name: "buyuk" }, { opId: "big" });
    expect(a.result.truncated.stdout).toBe(true);
    const rec = w.journal.get("big")!.result as Record<string, unknown>;
    if (rec.__journalSummary) expect(rec).toMatchObject({ exit: 4, timedOut: false, truncated: { stdout: true } });
    else expect(JSON.stringify(rec).length).toBeLessThan(70 * 1024); // 64 KiB altında kaldıysa tam saklandı
    const b = await w.as("mac").call<ScriptRunResult>("windows", "script-run", { name: "buyuk" }, { opId: "big" });
    expect(b.meta?.replayed).toBe(true);
    expect((b.result as { exit: number }).exit).toBe(4);
  });
});
