import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/kb/index.js";
import { approveTrustSync, guardTrust, ownsWorktree, type GuardDeps, type SyncPane } from "../../src/tasks/trust-guard.js";
import { winPane } from "../../src/tasks/nudge-win.js";

// F-vlad-335 / T20261121-79: launch sonrası güven kaydı gözetimi + güven ekranı onayı (posix tmux ve Windows)
const TRUST = "Quick safety check: Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder\n   2. No, exit";

function fakePane(screens: string[], o: { exists?: boolean } = {}) {
  const keys: string[] = [];
  let i = 0;
  const pane: SyncPane = {
    exists: () => { if (o.exists === false) throw new Error("pencere yok"); },
    capture: () => screens[Math.min(i, screens.length - 1)],
    enter: () => { keys.push("Enter"); i++; },
  };
  return { pane, keys };
}

describe("approveTrustSync", () => {
  it("güven ekranında yalnız Enter gönderir; ekran kalkınca true", () => {
    const f = fakePane([TRUST, "> hazır"]);
    expect(approveTrustSync(f.pane, () => {})).toBe(true);
    expect(f.keys).toEqual(["Enter"]);
  });
  it("pencere yoksa ya da ekran güven ekranı değilse tuş göndermez", () => {
    const a = fakePane([TRUST], { exists: false });
    expect(approveTrustSync(a.pane, () => {})).toBe(false);
    expect(a.keys).toEqual([]);
    const b = fakePane(["> hazır"]);
    expect(approveTrustSync(b.pane, () => {})).toBe(false);
    expect(b.keys).toEqual([]);
  });
  it("Enter sonrası ekran kalkmadıysa false (ikinci tuş yok)", () => {
    const f = fakePane([TRUST]);
    expect(approveTrustSync(f.pane, () => {})).toBe(false);
    expect(f.keys).toEqual(["Enter"]);
  });
  it("Windows konsol penceresi aynı yoldan onaylanır (winPane: SCREEN + enter)", () => {
    const calls: string[] = [];
    let entered = false;
    const run = (_f: string, _a: string[], env: Record<string, string>): string => {
      calls.push(env.VLAD_NUDGE_MODE);
      if (env.VLAD_NUDGE_MODE === "find") return "PID 42\n";
      if (env.VLAD_NUDGE_MODE === "enter") { entered = true; return "OK\n"; }
      return `SCREEN ${Buffer.from(entered ? "> hazır" : TRUST, "utf8").toString("base64")}\n`;
    };
    expect(approveTrustSync(winPane("T1", run) as unknown as SyncPane, () => {})).toBe(true);
    expect(calls.filter((c) => c === "enter")).toHaveLength(1);
    expect(calls.some((c) => c === "type")).toBe(false); // metin yazılmaz
  });
});

describe("guardTrust (launch sonrası pencere)", () => {
  function deps(o: { recorded: boolean[]; screens?: string[] }): { d: GuardDeps; log: string[]; rewrites: () => number; t: () => number } {
    let clock = 0, n = 0, rw = 0;
    const log: string[] = [];
    const f = fakePane(o.screens ?? ["> hazır"]);
    const d: GuardDeps = {
      recorded: () => o.recorded[Math.min(n++, o.recorded.length - 1)],
      rewrite: () => { rw++; return null; },
      pane: f.pane,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      sleepSync: () => {},
      log: (m) => { log.push(m); },
    };
    return { d, log, rewrites: () => rw, t: () => clock };
  }
  it("kayıt pencere boyunca kaybolursa yeniden yazılır (ardışık iki launch senaryosu)", async () => {
    // başka bir çalışan ~/.claude.json'u eski kopyayla ezer: 2. ve 5. yoklamada kayıt yok
    const x = deps({ recorded: [true, false, true, true, false, true] });
    const r = await guardTrust({ dir: "/wt/T1", taskId: "T1", windowMs: 30_000, intervalMs: 5_000 }, x.d);
    expect(r.rewrites).toBe(2);
    expect(x.rewrites()).toBe(2);
    expect(x.t()).toBeGreaterThanOrEqual(30_000); // pencere sonuna kadar izlenir
  });
  it("güven ekranı görünürse bir kez onaylar ve günlüğe yazar; çalışan ekranda takılı kalmaz", async () => {
    const x = deps({ recorded: [true], screens: [TRUST, "> hazır"] });
    const r = await guardTrust({ dir: "/wt/T1", taskId: "T1", windowMs: 20_000, intervalMs: 5_000 }, x.d);
    expect(r.approved).toBe(true);
    expect(x.log.join("\n")).toMatch(/güven ekranı otomatik onaylandı/);
  });
  it("ekran yoksa onay denenmez; kayıt sağlamsa hiçbir şey yazılmaz", async () => {
    const x = deps({ recorded: [true] });
    const r = await guardTrust({ dir: "/wt/T1", taskId: "T1", windowMs: 10_000, intervalMs: 5_000 }, x.d);
    expect(r).toEqual({ rewrites: 0, approved: false });
    expect(x.log).toEqual([]);
  });
});

describe("ownsWorktree (yalnız VLAD'ın kendi worktree'si)", () => {
  const cfg = { ...defaultConfig(), worktreeDir: "{repo}-wt" };
  it("worktreeDir altında ve görev kimliğiyle eşleşen yol sahiplenilir (posix ve Windows)", () => {
    expect(ownsWorktree({ id: "T1", worktree: "/Users/x/dev/vlad-wt/T1", repoPath: "/Users/x/dev/vlad" }, cfg, "darwin")).toBe(true);
    expect(ownsWorktree({ id: "T1", worktree: "C:\\dev\\vlad-wt\\T1", repoPath: "C:\\dev\\vlad" }, cfg, "win32")).toBe(true);
    expect(ownsWorktree({ id: "T1", worktree: "c:/DEV/vlad-wt/T1", repoPath: "C:\\dev\\vlad" }, cfg, "win32")).toBe(true);
  });
  it("yabancı yol, başka görevin yolu ya da kartsız görev sahiplenilmez", () => {
    expect(ownsWorktree({ id: "T1", worktree: "/Users/x/Documents/proje", repoPath: "/Users/x/dev/vlad" }, cfg, "darwin")).toBe(false);
    expect(ownsWorktree({ id: "T1", worktree: "/Users/x/dev/vlad-wt/T2", repoPath: "/Users/x/dev/vlad" }, cfg, "darwin")).toBe(false);
    expect(ownsWorktree({ id: "T1", worktree: "/Users/x/dev/vlad-wt/../etc/T1", repoPath: "/Users/x/dev/vlad" }, cfg, "darwin")).toBe(false);
    expect(ownsWorktree({ id: "T1", worktree: "/Users/x/dev/vlad-wt/T1", repoPath: null }, cfg, "darwin")).toBe(false);
  });
});
