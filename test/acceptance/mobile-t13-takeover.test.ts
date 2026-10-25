// T13 kabul (T20261025-90): takeover sonrası salt okunur ve takeover öncesi yazmaların kaybolmaması.
// Kaynak: topoloji notu K8 "Takeover sonrası salt okunur", "Pull'dan önce Windows'ta yapılmış yazmalar push sırasında
// merge'lenir; kaybolmaz". Promote yerine `landServerBranchOnMain` kullanılır (gerçek promote: server/test/acceptance).
// S13b (`kb pull|sync`, push öncesi fetch+merge) uygulanana kadar kırmızı kalabilir.
import { describe, expect, it } from "vitest";
import { makeWorld, newRunningTask, taskRel, type Machine, type World } from "../../server/test/helpers/kbRepos.ts";

const JOURNAL = (d: string) => ["journal", "append", d, "--file", "-"];

/** Windows etkin, sunucu devralıp main'e indirir; windows henüz pull etmedi. */
function serverTakesOver(w: World, win: Machine, srv: Machine): void {
  srv.ok(["kb", "sync"]); // main'i alır (windows etkin)
  srv.ok(["active", "claim", "--takeover"]);
  srv.ok(["kb", "sync"]); // claim commit'lenir, kb-server'a gider
  w.landServerBranchOnMain();
  expect(w.mainFile("active.md")).toMatch(/machine: srvbox/);
  expect(win.activeMachine()).toBe("winbox"); // pull'dan önce windows kendini etkin sanıyor
}

describe("acceptance: kb topology takeover", () => {
  it("acceptance: kb topology after takeover windows pulls -> writes active_elsewhere, reads ok, own worker log allowed", () => {
    const w = makeWorld();
    const win = w.machines.winbox!, srv = w.machines.srvbox!;
    win.ok(["active", "claim"]);
    const id = newRunningTask(win);
    const other = newRunningTask(win);
    win.ok(["kb", "commit", "windows etkin, iki çalışan görev", "--push"]);

    serverTakesOver(w, win, srv);

    // windows pull eder: yeni active.md gelir
    const pull = win.ok(["kb", "pull"]);
    expect(pull).toMatchObject({ activeMachine: "srvbox" });
    expect(win.activeMachine()).toBe("srvbox");

    // yazma komutları active_elsewhere ile durur ve dosya değişmez
    const before = win.git("status", "--porcelain");
    for (const args of [JOURNAL("2026-10-25"), ["decision", "add", "--project", "alpha", "--title", "t", "--body-file", "-"]]) {
      expect(win.fail(args, { input: "x\n" }).error).toMatch(/^active_elsewhere/);
    }
    expect(win.fail(["task", "log", id, "çalışan olmayan"]).error).toMatch(/^active_elsewhere/);
    expect(win.git("status", "--porcelain")).toBe(before);

    // okumalar serbest
    expect(win.ok(["active", "show"])).toMatchObject({ mine: false, active: { machine: "srvbox" } });
    expect(win.ok<{ tasks: unknown[] }>(["task", "list"]).tasks.length).toBeGreaterThanOrEqual(2);
    expect(win.ok<{ projects?: unknown[] } | unknown[]>(["project", "list"])).toBeTruthy();

    // çalışan kendi görevine yazabilir (muafiyet), başka göreve yazamaz
    win.ok(["task", "log", id, "kendi çalışan satırım"], { env: { VLAD_TASK_ID: id } });
    expect(win.read(taskRel(win, id))).toMatch(/kendi çalışan satırım/);
    const bad = win.run(["task", "log", other, "yanlış görev", "--json"], { env: { VLAD_TASK_ID: id } });
    expect(bad.code).toBe(1);
    expect(win.read(taskRel(win, other))).not.toMatch(/yanlış görev/);
  });

  it("acceptance: kb topology windows writes before its pull reach main after takeover", () => {
    const w = makeWorld();
    const win = w.machines.winbox!, srv = w.machines.srvbox!;
    win.ok(["active", "claim"]);
    win.write("journal/2026-10-26.md", "# windows, takeover öncesi\n");
    win.ok(["kb", "commit", "windows önce", "--push"]);

    // sunucu da kendi yazmasını yapar, sonra devralır
    srv.ok(["kb", "sync"]);
    srv.write("journal/2026-10-27.md", "# sunucu, takeover öncesi\n");
    serverTakesOver(w, win, srv);

    // windows pull etmeden yazar (yerel görünümde hâlâ etkin: guard geçer)
    win.ok(JOURNAL("2026-10-28"), { input: "# windows, pull'dan önce\n" });
    win.ok(["kb", "commit", "windows pull'dan önce"]);
    const winCommit = win.git("rev-parse", "HEAD");

    // push: non-ff -> fetch + merge + push; yazma kaybolmaz
    const r = win.run(["kb", "commit", "push", "--push", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ pushed: true });
    expect(w.mainFile("journal/2026-10-28.md")).toMatch(/pull'dan önce/);
    expect(w.mainFile("journal/2026-10-27.md")).toMatch(/takeover öncesi/);
    expect(w.mainFile("journal/2026-10-26.md")).toMatch(/windows, takeover öncesi/);
    expect(w.remoteGit("merge-base", "--is-ancestor", winCommit, "main")).toBe("");
    // takeover geri alınmadı: kazanan sunucu, windows artık salt okunur
    expect(w.mainFile("active.md")).toMatch(/machine: srvbox/);
    expect(win.ok(["active", "show"])).toMatchObject({ mine: false });
    expect(win.fail(JOURNAL("2026-10-29"), { input: "x\n" }).error).toMatch(/^active_elsewhere/);
  });
});
