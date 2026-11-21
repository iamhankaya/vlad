import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../../src/agent/client.js";
import { Journal } from "../../src/agent/journal.js";
import { isAllowed } from "../../src/agent/ops/index.js";
import { nudgeOp } from "../../src/agent/ops/nudge.js";
import { startServer, type RunningServer } from "../../src/agent/server.js";
import { remoteNudge } from "../../src/machines/remote.js";
import { NoWindowError, type NudgePane } from "../../src/tasks/nudge.js";
import { RemoteError, type AgentOp } from "../../src/fleet/types.js";
import { rmTemp } from "../helpers.js";

// F-vlad-370: görev başka makinede (windows) koşarken `task nudge` isteği o makinenin Agent'ına gider; pencere işleyicisi sahte pencereyle.
const KEY = "cd".repeat(32);
const dirs: string[] = []; const servers: RunningServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const d of dirs.splice(0)) rmTemp(d); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-nr-")); dirs.push(d); return d; };

/** Sahte pencere (kutu + Enter yutma sayısı); type/enter çağrılarını sayar. */
function fakePane(o: { exists?: boolean; swallow?: number } = {}) {
  const log: string[] = []; let typed = ""; let enters = 0;
  const pane: NudgePane = {
    exists: () => { log.push("exists"); if (o.exists === false) throw new NoWindowError("çalışan penceresi yok: T20261121-50"); },
    type: (t) => { log.push(`type:${t}`); typed = t; },
    enter: () => { log.push("enter"); if (++enters > (o.swallow ?? 0)) typed = ""; },
    capture: () => `● x\n╭──╮\n│ > ${typed}\n╰──╯`,
  };
  return { pane, log };
}
const deps = (p: NudgePane) => ({ platform: "win32" as const, pane: () => p, sleep: async () => {} });

describe("nudgeOp (işçi tarafı işleyici, sahte pencere)", () => {
  it("metni yazar, Enter yollar, teslimi döner", async () => {
    const f = fakePane({ swallow: 1 });
    expect(await nudgeOp({ taskId: "T20261121-50", text: "devam et" }, deps(f.pane))).toEqual({ delivered: true, enters: 2 });
    expect(f.log).toEqual(["exists", "type:devam et", "enter", "enter"]);
  });
  it("teslim edilemezse delivered=false (hata değil)", async () => {
    const f = fakePane({ swallow: 99 });
    expect(await nudgeOp({ taskId: "T20261121-50", text: "devam et" }, deps(f.pane))).toMatchObject({ delivered: false, enters: 5 });
  });
  it("pencere yoksa not_found", async () => {
    const e = await nudgeOp({ taskId: "T20261121-50", text: "x" }, deps(fakePane({ exists: false }).pane)).catch((x) => x);
    expect(e).toBeInstanceOf(RemoteError); expect(e.code).toBe("not_found"); expect(e.message).toMatch(/penceresi yok/);
  });
  it.each([
    [{ taskId: "../x", text: "a" }, /taskId/], [{ taskId: "T20261121-50", text: "a\nb" }, /tek satır/], [{ taskId: "T20261121-50", text: "" }, /text/],
    [{ taskId: "T20261121-50", text: "a".repeat(4001) }, /text/], [{ taskId: "T20261121-50", text: "a", session: "x" }, /bilinmeyen alan/], ["x", /nesne/],
  ])("geçersiz argüman %j → bad_request", async (args, re) => {
    const f = fakePane();
    const e = await nudgeOp(args, deps(f.pane)).catch((x) => x);
    expect(e.code).toBe("bad_request"); expect(e.message).toMatch(re); expect(f.log).toEqual([]);
  });
});

describe("rol izni: nudge yalnız beyinden işçi Agent'ına", () => {
  it.each([["worker-agent", "brain", true], ["worker-agent", "console", false], ["worker-agent", "worker", false], ["worker-agent", "self", false], ["brain-agent", "worker", false], ["brain-agent", "console", false]] as const)("%s ← %s: %s", (kind, role, ok) => {
    expect(isAllowed(kind, role, "nudge" as AgentOp)).toBe(ok);
  });
});

describe("protokol: beyin → windows Agent (gerçek sunucu/istemci, sahte pencere)", () => {
  async function setup(p: NudgePane) {
    const cfg = { brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 1 } }, { name: "win", os: "win32", agent: { host: "127.0.0.1", port: 1 } }] } as never;
    const ops = { nudge: (a: unknown) => nudgeOp(a, deps(p)) } as never;
    const srv = await startServer({ self: "win", kind: "worker-agent", cfg: () => cfg, keys: { mac: KEY }, ops, journal: new Journal(join(tmp(), "j.jsonl"), () => Date.now()), build: "t", bind: "127.0.0.1", port: 0 });
    servers.push(srv);
    const cfg2 = { brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 1 } }, { name: "win", os: "win32", agent: { host: "127.0.0.1", port: srv.port } }] } as never;
    return { brain: new AgentClient({ self: "mac", keys: { win: KEY }, config: () => cfg2 }), console: new AgentClient({ self: "mac", keys: { win: KEY }, config: () => cfg2 }) };
  }
  it("remoteNudge isteği windows Agent'ına gider ve teslim sonucu döner", async () => {
    const f = fakePane();
    const { brain } = await setup(f.pane);
    expect(await remoteNudge(brain, "win", "T20261121-50", "lütfen devam et")).toEqual({ delivered: true, enters: 1 });
    expect(f.log).toEqual(["exists", "type:lütfen devam et", "enter"]);
  });
  it("pencere kapalıysa not_found uçtan uca yükselir", async () => {
    const { brain } = await setup(fakePane({ exists: false }).pane);
    await expect(remoteNudge(brain, "win", "T20261121-50", "x")).rejects.toMatchObject({ code: "not_found" });
  });
});
