import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, kbPaths, type VladConfig } from "../../src/kb/index.js";
import { RemoteError } from "../../src/fleet/types.js";
import { createTask, getTask, setState } from "../../src/tasks/index.js";
import { statusSummary } from "../../src/tasks/launch.js";
import { applyRemoteStalls, probeRemoteWorkers } from "../../src/tasks/liveness.js";
import { makeHome } from "../helpers.js";
import { FakeTransport } from "./harness.js";

const MIN = 60_000;
let cfg: VladConfig;
const NOW = new Date("2026-11-01T12:00:00Z");
const ago = (m: number) => new Date(NOW.getTime() - m * MIN).toISOString();

// saveTask hep şimdiyi yazar: eski `updated` fixture'ı dosyada doğrudan ayarlanır
function setUpdated(id: string, iso: string): void {
  const f = getTask(id).file;
  writeFileSync(f, readFileSync(f, "utf8").replace(/^updated: .*$/m, `updated: ${iso}`));
}

function mkRunning(machine: string, updatedMin: number): string {
  const id = createTask({ project: "p", title: "t", kind: "dev", body: "## Tanım\nx\n" }).data.id;
  setState(id, "running", { machine, worktree: `W:\\wt\\${id}` });
  setUpdated(id, ago(updatedMin));
  return id;
}

beforeEach(() => {
  const home = makeHome();
  cfg = { ...defaultConfig(), brain: "mac", machines: [
    { name: "mac", os: "darwin", agent: { port: 7437 } },
    { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 } },
    { name: "linux2", os: "linux", agent: { host: "10.0.0.3", port: 7437 } },
  ] };
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify(cfg));
  writeFileSync(join(kbPaths().projects, "p.md"), "---\nslug: p\nname: p\npath: /Users/x/dev/prj\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n");
});

describe("machines:C3 uzak liveness (beyin)", () => {
  it("makine başına TEK çağrı; args {id, project, repoName}; brain görevi çağrıya girmez", async () => {
    const a = mkRunning("windows", 120), b = mkRunning("windows", 90), c = mkRunning("mac", 120);
    const tr = new FakeTransport(() => ({ results: {} }));
    await probeRemoteWorkers(cfg, tr, NOW);
    expect(tr.calls).toHaveLength(1);
    expect(tr.calls[0]).toMatchObject({ to: "windows", op: "liveness" });
    const tasks = (tr.calls[0].args as any).tasks as any[];
    expect(tasks.map((t) => t.id).sort()).toEqual([a, b].sort());
    expect(tasks[0]).toMatchObject({ project: "p", repoName: "prj" });
    expect(tasks.map((t) => t.id)).not.toContain(c);
  });

  it("idle = min(brain updated, ageMs): işçi yeni yazmış → stalled değil", async () => {
    const id = mkRunning("windows", 120);
    const tr = new FakeTransport(() => ({ results: { [id]: { ageMs: 2 * MIN, hasProcess: true } } }));
    expect(await probeRemoteWorkers(cfg, tr, NOW)).toEqual([]);
  });

  it("ageMs null + süreç yok + görev uzun süredir güncellenmemiş → silent planı", async () => {
    const id = mkRunning("windows", 120);
    const tr = new FakeTransport(() => ({ results: { [id]: { ageMs: null, hasProcess: false } } }));
    expect(await probeRemoteWorkers(cfg, tr, NOW)).toMatchObject([{ id, machine: "windows", reason: "silent" }]);
  });

  it("işçi saati kaymış olsa da yalnız ageMs taşınır: süreç canlı + ageMs 20 dk → 4x eşiği altında", async () => {
    const id = mkRunning("windows", 300);
    const tr = new FakeTransport(() => ({ results: { [id]: { ageMs: 20 * MIN, hasProcess: true } } }));
    expect(await probeRemoteWorkers(cfg, tr, NOW)).toEqual([]);
  });

  it("makine erişilemiyor + sessizlik eşiği doldu → unreachable; yeni güncellenmişse plan yok", async () => {
    const old = mkRunning("windows", 120), fresh = mkRunning("linux2", 1);
    const tr = new FakeTransport(() => { throw new RemoteError("unreachable", "x", "m"); });
    const plans = await probeRemoteWorkers(cfg, tr, NOW);
    expect(plans.map((p) => [p.id, p.reason])).toEqual([[old, "unreachable"]]);
    expect(plans.find((p) => p.id === fresh)).toBeUndefined();
  });

  it("unreachable/timeout dışı hata (failed/auth) stalled planı üretmez", async () => {
    mkRunning("windows", 120);
    const tr = new FakeTransport(() => { throw new RemoteError("failed", "x", "m"); });
    expect(await probeRemoteWorkers(cfg, tr, NOW)).toEqual([]);
  });

  it("yanıt vermeyen makine toplam bütçeyi aşmaz (erişilemez sayılır); diğer makine etkilenmez", async () => {
    const a = mkRunning("windows", 120), b = mkRunning("linux2", 120);
    const tr = new FakeTransport((c) => (c.to === "windows" ? new Promise(() => {}) : { results: { [b]: { ageMs: null, hasProcess: false } } }));
    const t0 = Date.now();
    const plans = await probeRemoteWorkers(cfg, tr, NOW, { budgetMs: 200 });
    expect(Date.now() - t0).toBeLessThan(3000); // bütçe 200 ms; yük altında geniş pay
    expect(plans.map((p) => [p.id, p.reason]).sort()).toEqual([[a, "unreachable"], [b, "silent"]].sort());
  });

  it("applyRemoteStalls: stalled + hata metni; arada güncellenen görev dokunulmaz", () => {
    const a = mkRunning("windows", 120), b = mkRunning("windows", 120);
    const plans = [
      { id: a, updated: getTask(a).data.updated, machine: "windows", reason: "unreachable" as const },
      { id: b, updated: getTask(b).data.updated, machine: "windows", reason: "silent" as const },
    ];
    setUpdated(b, ago(0));
    expect(applyRemoteStalls(plans).map((x) => x.data.id)).toEqual([a]);
    expect(getTask(a).data.state).toBe("stalled");
    expect(getTask(a).data.error).toBe("makine erişilemiyor: windows");
    expect(getTask(b).data.state).toBe("running");
  });

  it("statusSummary: mark açıkken planlar uygulanır ve newlyStalled'a girer; mark:false'ta uygulanmaz", () => {
    const a = mkRunning("windows", 120);
    const plan = [{ id: a, updated: getTask(a).data.updated, machine: "windows", reason: "unreachable" as const }];
    expect(statusSummary(cfg, NOW, undefined, "linux", { mark: false, remotePlans: plan }).newlyStalled).toEqual([]);
    expect(getTask(a).data.state).toBe("running");
    expect(statusSummary(cfg, NOW, undefined, "linux", { mark: true, remotePlans: plan }).newlyStalled).toContain(a);
    expect(getTask(a).data.state).toBe("stalled");
  });

  it("bozuk bir proje kartı diğer görevlerin probunu kapatmaz", async () => {
    const good = mkRunning("windows", 120);
    const badId = createTask({ project: "bozuk", title: "t", kind: "dev", body: "## Tanım\nx\n" }).data.id;
    setState(badId, "running", { machine: "windows", worktree: "W:/wt/x" });
    writeFileSync(join(kbPaths().projects, "bozuk.md"), "---\n: : [bozuk\n---\n");
    const tr = new FakeTransport(() => ({ results: { [good]: { ageMs: null, hasProcess: false } } }));
    const plans = await probeRemoteWorkers(cfg, tr, NOW);
    expect(plans.map((x) => x.id)).toEqual([good]);
  });
});
