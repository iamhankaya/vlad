import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activeHandlers } from "../../src/http/routes-active.ts";
import { kbSyncView } from "../../src/kbsync/home.ts";
import { mainActiveMachine, promoteKb, type PromoteDeps, type PromoteResult } from "../../src/kbsync/promote.ts";
import { StateStore } from "../../src/kbsync/state.ts";
import { createTakeover, readSyncStatus, requestSync, settlePendingTakeover, TakeoverError, waitSync, type KbSyncStatus, type TakeoverDeps } from "../../src/kbsync/takeover.ts";
import { pairDevice, rig, signedCall } from "../helpers/client.ts";
import { validator } from "../helpers/openapi.ts";
import { git, makeWorld, type Machine, type World } from "../helpers/kbRepos.ts";
import { makePromoteEnv, pushToServerBranch } from "../helpers/kbPromote.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-tk-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const STATUS = (seq: number, o: Partial<KbSyncStatus> = {}): KbSyncStatus => ({ v: 1, seq, at: new Date().toISOString(), ok: true, phase: "done", ...o });
const writeStatus = (kb: string, s: KbSyncStatus) => { mkdirSync(join(kb, "logs"), { recursive: true }); writeFileSync(join(kb, "logs", "kbsync.status.json"), JSON.stringify(s)); };

/** Fakes for the whole sequence; `log` records the order of side effects. */
function fakes(o: { sync?: (seq: number, n: number) => KbSyncStatus | null; promote?: () => PromoteResult; main?: () => string | null } = {}) {
  const kb = tmp(), stateDir = tmp();
  const log: string[] = [];
  let syncs = 0;
  const d: TakeoverDeps = {
    serverMachine: "srvbox", stateDir, now: () => Date.now(),
    requestSync: (reason) => { const seq = requestSync(kb, reason); log.push(`request:${reason}`); return seq; },
    waitSync: async (seq) => { log.push("wait"); return (o.sync ?? ((s) => STATUS(s)))(seq, ++syncs); },
    claim: async () => { log.push("claim --takeover"); },
    promote: async (p) => { log.push(`promote:${p.trigger}:${p.waitLockMs}`); return (o.promote ?? (() => ({ promoted: true, main: "m" })))(); },
    mainActive: async () => (o.main ?? (() => "srvbox"))(),
  };
  return { d, kb, stateDir, log, takeover: createTakeover(d) };
}

describe("server: takeover", () => {
  it("server: takeover order sync -> claim --takeover -> sync -> promote -> active", async () => {
    const f = fakes();
    expect(await f.takeover()).toEqual({ state: "active" });
    expect(f.log).toEqual(["request:takeover", "wait", "claim --takeover", "request:takeover-claim", "wait", "promote:takeover:15000"]);
    expect(new StateStore(f.stateDir).read().takeover).toMatchObject({ state: "active" });
  });

  it("server: takeover pre-sync conflict -> 409 kb_conflict, claim not run", async () => {
    const f = fakes({ sync: (seq) => STATUS(seq, { ok: false, phase: "merge", error: "kb_conflict" }) });
    await expect(f.takeover()).rejects.toMatchObject({ code: "kb_conflict" });
    expect(f.log).not.toContain("claim --takeover");
    expect(f.log.some((l) => l.startsWith("promote"))).toBe(false);
    // a failing fetch is "unavailable", not a conflict
    const g = fakes({ sync: (seq) => STATUS(seq, { ok: false, phase: "fetch", error: "kb_fetch_failed" }) });
    await expect(g.takeover()).rejects.toMatchObject({ code: "kb_sync_unavailable" });
    expect(g.log).not.toContain("claim --takeover");
  });

  it("server: takeover kbsync silent 20 s -> 503 kb_sync_unavailable, claim not run", async () => {
    const kb = tmp();
    let t = 1_000_000;
    const seq = requestSync(kb, "takeover", () => t);
    const slept: number[] = [];
    const r = await waitSync(kb, seq, { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    expect(r).toBeNull();
    expect(t - 1_000_000).toBeGreaterThanOrEqual(20_000);
    expect(slept.length).toBeGreaterThan(10);
    const f = fakes({ sync: () => null });
    await expect(f.takeover()).rejects.toMatchObject({ code: "kb_sync_unavailable" });
    expect(f.log).not.toContain("claim --takeover");
    // a status from an older cycle (lower seq) is not an answer
    writeStatus(kb, STATUS(seq - 1));
    expect(await waitSync(kb, seq, { now: () => t, sleep: async (ms) => { t += ms; }, timeoutMs: 1000 })).toBeNull();
    writeStatus(kb, STATUS(seq));
    expect((await waitSync(kb, seq))?.seq).toBe(seq);
  });

  it("server: requestSync numbers requests above everything seen and leaves a hint file only", () => {
    const kb = tmp();
    expect(requestSync(kb, "a")).toBe(1);
    expect(requestSync(kb, "b")).toBe(2);
    writeStatus(kb, STATUS(7));
    expect(requestSync(kb, "c")).toBe(8);
    expect(JSON.parse(readFileSync(join(kb, "logs", "kbsync.request"), "utf8"))).toMatchObject({ seq: 8, reason: "c" });
    writeFileSync(join(kb, "logs", "kbsync.status.json"), "{not json");
    expect(readSyncStatus(kb)).toBeNull();
    expect(requestSync(kb, "d")).toBe(9);
  });

  it("server: concurrent takeover -> 409 takeover_in_progress", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakes();
    f.d.claim = async () => { f.log.push("claim --takeover"); await gate; };
    const first = f.takeover();
    await new Promise((r) => setTimeout(r, 20));
    await expect(f.takeover()).rejects.toMatchObject({ code: "takeover_in_progress" });
    release();
    expect(await first).toEqual({ state: "active" });
    expect(f.log.filter((l) => l === "claim --takeover")).toHaveLength(1);
    // once finished, the next one runs
    expect(await f.takeover()).toEqual({ state: "active" });
  });

  it("server: takeover triggers promote, failure shows pending card", async () => {
    const f = fakes({ promote: () => ({ promoted: false, reason: "rejected", card: "C-20261025-07" }), main: () => "winbox" });
    expect(await f.takeover()).toEqual({ state: "pending", reason: "rejected" });
    expect(new StateStore(f.stateDir).read().takeover).toMatchObject({ state: "pending", reason: "rejected" });
    // the home view carries it next to the blocked state
    new StateStore(f.stateDir).update((s) => { s.blocked = { key: "k", card: "C-20261025-07", at: new Date().toISOString() }; });
    const v = kbSyncView({ kbDir: f.kb, stateDir: f.stateDir, now: () => Date.now() });
    expect(v.takeover).toMatchObject({ state: "pending", reason: "rejected" });
    expect(v.kb_sync).toMatchObject({ state: "blocked", card: "C-20261025-07" });
    // main names another machine though promote succeeded (windows claimed first): still pending, with that reason
    const g = fakes({ main: () => "winbox" });
    expect(await g.takeover()).toEqual({ state: "pending", reason: "active_elsewhere" });
    // the post-claim sync failing leaves the claim written but not landed
    const h = fakes({ sync: (seq, n) => (n === 1 ? STATUS(seq) : STATUS(seq, { ok: false, phase: "merge", error: "kb_conflict" })) });
    expect(await h.takeover()).toEqual({ state: "pending", reason: "kb_conflict" });
    expect(h.log.some((l) => l.startsWith("promote"))).toBe(false);
  });

  it("server: pending takeover becomes active after a later promote", async () => {
    const f = fakes({ promote: () => ({ promoted: false, reason: "main_moved" }), main: () => null });
    expect(await f.takeover()).toEqual({ state: "pending", reason: "main_moved" });
    let main: string | null = null;
    const settle = (r: PromoteResult) => settlePendingTakeover({ serverMachine: "srvbox", stateDir: f.stateDir, now: () => Date.now(), mainActive: async () => main }, r);
    expect(await settle({ promoted: false, reason: "github_unavailable" })).toBeNull(); // no fetched main: nothing to judge
    expect(await settle({ promoted: false, reason: "up_to_date", main: "m" })).toBeNull(); // main has no active.md yet
    main = "srvbox";
    expect(await settle({ promoted: true, main: "m2" })).toBe("active");
    expect(new StateStore(f.stateDir).read().takeover).toMatchObject({ state: "active" });
    expect(await settle({ promoted: true, main: "m3" })).toBeNull(); // settled: later runs leave it alone
  });

  it("server: pending takeover lost when main active.md names another machine", async () => {
    const f = fakes({ promote: () => ({ promoted: false, reason: "merge_conflict" }), main: () => null });
    await f.takeover();
    const r = await settlePendingTakeover({ serverMachine: "srvbox", stateDir: f.stateDir, now: () => Date.now(), mainActive: async () => "winbox" }, { promoted: false, reason: "up_to_date", main: "m" });
    expect(r).toBe("lost");
    expect(new StateStore(f.stateDir).read().takeover).toMatchObject({ state: "lost" });
  });
});

describe("server: takeover against real git (kb sync, claim, promote, main)", () => {
  /** What systemd's kbsync timer does when poked: one `vlad kb sync` on the server clone. */
  function realWorld() {
    const w: World = makeWorld();
    const srv = w.machines.srvbox!, win = w.machines.winbox!;
    const env = makePromoteEnv(w);
    const stateDir = tmp();
    const deps: PromoteDeps = { ...env.deps, config: { ...env.deps.config, stateDir } };
    const order: string[] = [];
    const d: TakeoverDeps = {
      serverMachine: "srvbox", stateDir, now: () => Date.now(),
      requestSync: (reason) => requestSync(srv.kb, reason),
      waitSync: async (seq) => { order.push("sync"); try { srv.ok(["kb", "sync"]); } catch { /* status file carries the outcome */ } return waitSync(srv.kb, seq, { timeoutMs: 100 }); },
      claim: async () => { order.push("claim"); srv.ok(["active", "claim", "--takeover"]); },
      promote: async (o) => { order.push("promote"); return promoteKb(deps, o); },
      mainActive: () => mainActiveMachine(deps),
    };
    return { w, srv, win, env, deps, stateDir, order, takeover: createTakeover(d) };
  }

  it("server: takeover lands the claim on main and Windows becomes read-only after its next pull", async () => {
    const x = realWorld();
    x.win.ok(["active", "claim"]);
    x.win.ok(["kb", "commit", "windows etkin", "--push"]);
    expect(x.w.mainFile("active.md")).toMatch(/machine: winbox/);
    expect(await x.takeover()).toEqual({ state: "active" });
    expect(x.order).toEqual(["sync", "claim", "sync", "promote"]);
    expect(x.w.mainFile("active.md")).toMatch(/machine: srvbox/);
    x.win.ok(["kb", "pull"]);
    expect(x.win.activeMachine()).toBe("srvbox");
    expect(x.win.fail(["journal", "append", "2026-10-26", "--file", "-"], { input: "x\n" }).error).toMatch(/^active_elsewhere/);
  });

  it("server: takeover stays pending while promote refuses the server branch; removing the file is not enough, the history is checked", async () => {
    const x = realWorld();
    x.srv.write("src/evil.ts", "x\n");
    expect(await x.takeover()).toEqual({ state: "pending", reason: "rejected" });
    expect(x.w.mainFile("active.md")).toBeNull();
    expect(x.env.cards).toHaveLength(1); // one kb_conflict card for the refusal
    // the agent deletes the file in a later commit: the net diff is clean, the history is not (R2), so it stays refused
    rmSync(join(x.srv.kb, "src"), { recursive: true });
    x.srv.ok(["kb", "sync"]);
    const res = await promoteKb(x.deps);
    expect(res).toMatchObject({ promoted: false, reason: "rejected", violations: [{ rule: "path_not_allowed", path: "src/evil.ts" }] });
    expect(x.env.cards).toHaveLength(1); // same violation, same key: no second card
    expect(await settlePendingTakeover({ serverMachine: "srvbox", stateDir: x.stateDir, now: () => Date.now(), mainActive: () => mainActiveMachine(x.deps) }, res)).toBeNull();
    expect(new StateStore(x.stateDir).read().takeover).toMatchObject({ state: "pending" });
    expect(new StateStore(x.stateDir).read().blocked).not.toBeNull();
    // `discard` (rebuild kb-server on main, as the kbsync cycle does for an answered card) unblocks it
    const d = x.w.scratch("main");
    git(d, ["checkout", "-q", "-B", "kb-server", "origin/main"]);
    writeFileSync(join(d, "active.md"), "---\nmachine: srvbox\nsince: 2026-10-25T00:00:00Z\nheartbeat: 2026-10-25T00:00:00Z\n---\n");
    git(d, ["add", "active.md"]);
    git(d, ["commit", "-q", "-m", "claim"]);
    git(d, ["push", "-q", "--force", "origin", "HEAD:refs/heads/kb-server"]);
    const landed = await promoteKb(x.deps);
    expect(landed).toMatchObject({ promoted: true });
    expect(await settlePendingTakeover({ serverMachine: "srvbox", stateDir: x.stateDir, now: () => Date.now(), mainActive: () => mainActiveMachine(x.deps) }, landed)).toBe("active");
  });
});

describe("server: takeover route", () => {
  const ok = validator({ $ref: "#/components/schemas/TakeoverResponse" });
  const err = validator({ $ref: "#/components/schemas/Error" });

  async function call(takeover: () => Promise<any>) {
    const r = rig({ extraHandlers: activeHandlers({ takeover }) });
    const d = await pairDevice(r);
    return signedCall(r, d, "POST", "/v1/active/takeover");
  }

  it("answers 200 active, 202 pending, 409 kb_conflict | takeover_in_progress, 503 kb_sync_unavailable, in the contract's shapes", async () => {
    const a = await call(async () => ({ state: "active" }));
    expect([a.statusCode, a.json()]).toEqual([200, { ok: true, state: "active" }]);
    expect(ok(a.json())).toEqual([]);
    const p = await call(async () => ({ state: "pending", reason: "main_moved" }));
    expect([p.statusCode, p.json()]).toEqual([202, { ok: true, state: "pending", reason: "main_moved" }]);
    expect(ok(p.json())).toEqual([]);
    for (const [code, status] of [["kb_conflict", 409], ["takeover_in_progress", 409], ["kb_sync_unavailable", 503]] as const) {
      const e = await call(async () => { throw new TakeoverError(code, "x"); });
      expect(e.statusCode).toBe(status);
      expect(e.json().error.code).toBe(code);
      expect(err(e.json())).toEqual([]);
      expect(e.body).not.toContain('"x"'); // the internal message stays server-side
    }
  });

  it("needs a signed session; unsigned gets 401 and never starts a takeover", async () => {
    let started = 0;
    const r = rig({ extraHandlers: activeHandlers({ takeover: async () => { started++; return { state: "active" }; } }) });
    const res = await r.app.inject({ method: "POST", url: "/v1/active/takeover" });
    expect(res.statusCode).toBe(401);
    expect(started).toBe(0);
  });

  it("without the gate configured the route answers 501", async () => {
    const r = rig();
    const d = await pairDevice(r);
    expect((await signedCall(r, d, "POST", "/v1/active/takeover")).statusCode).toBe(501);
  });

  it("GET /home carries active_vlad.takeover and kb_sync from the server state", async () => {
    const root = tmp();
    const stub = join(root, "cli.js");
    writeFileSync(stub, `const a=process.argv.slice(2).join(" ");const o={"task list":{tasks:[],warnings:[]},"card list --state open":{cards:[],warnings:[]},"quota show":{limited:false,until:null,warnings:[]},"active show":{active:{machine:"srvbox",since:"2026-10-25T14:00:00Z",heartbeat:"2026-10-25T15:00:00Z"},mine:true,warnings:[]}}[a.replace(" --json","")];console.log(JSON.stringify(o??{}));`);
    chmodSync(stub, 0o755);
    const saved = { ...process.env };
    process.env.VLAD_HOME = root;
    process.env.VLAD_CLI = stub;
    try {
      const kb = join(root, "kb"), stateDir = join(root, "state");
      writeStatus(kb, STATUS(3));
      new StateStore(stateDir).update((s) => { s.takeover = { state: "pending", reason: "main_moved", at: "2026-10-25T14:59:00Z" }; s.lastOk = new Date().toISOString(); });
      const r = rig({ read: { activeExtra: () => kbSyncView({ kbDir: kb, stateDir, now: () => Date.now() }) } });
      const d = await pairDevice(r);
      const res = await signedCall(r, d, "GET", "/v1/home");
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().active_vlad).toMatchObject({ machine: "srvbox", mine: true, takeover: { state: "pending", reason: "main_moved" }, kb_sync: { state: "ok" } });
      expect(validator({ $ref: "#/components/schemas/Home" })(res.json())).toEqual([]);
    } finally {
      for (const k of ["VLAD_HOME", "VLAD_CLI"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it("kb_sync view (finding 6): ok comes from promote's own lastOk only; the agent's status file can downgrade, never upgrade", () => {
    const kb = tmp(), stateDir = tmp();
    const view = (now: number) => kbSyncView({ kbDir: kb, stateDir, now: () => now }).kb_sync;
    const t0 = Date.parse("2026-10-25T12:00:00Z");
    expect(view(t0).state).toBe("stale"); // promote never ran
    writeStatus(kb, STATUS(1, { at: new Date(t0).toISOString() })); // a forged "all fine" changes nothing
    expect(view(t0).state).toBe("stale");
    new StateStore(stateDir).update((s) => { s.lastOk = new Date(t0).toISOString(); });
    expect(view(t0 + 4 * 60_000)).toEqual({ state: "ok", last_ok: new Date(t0).toISOString() });
    expect(view(t0 + 5 * 60_000 + 1).state).toBe("stale");
    writeStatus(kb, STATUS(2, { at: new Date(t0).toISOString(), ok: false, phase: "merge", error: "kb_conflict" }));
    expect(view(t0).state).toBe("conflict");
    new StateStore(stateDir).update((s) => { s.blocked = { key: "k", at: "x" }; });
    expect(view(t0).state).toBe("blocked");
  });
});
