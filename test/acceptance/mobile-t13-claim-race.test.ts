// T13 kabul (T20261025-90): çift VLAD claim yarışları. Kaynak: docs/superpowers/specs/2026-10-25-vlad-kb-topology.md
// K8 ("Eşzamanlı claim"), K4 (merge, `active.md` çakışmasında main kazanır), #### Test stratejisi -> T13.
// İki klon iki makinedir (`VLAD_MACHINE`); remote geçici bare repo (`file://`). CLI yalnız `dist/cli.js` alt süreciyle sınanır.
// `landServerBranchOnMain` temiz bir promote'un yerine geçer (gerçek `promoteKb` server/test/acceptance/kb-topology-*.test.ts'te).
// S13b (`kb sync`, push öncesi fetch+merge, kbPushBranch) uygulanana kadar bu dosya kırmızı kalabilir.
import { describe, expect, it } from "vitest";
import { makeWorld } from "../../server/test/helpers/kbRepos.ts";

const JOURNAL = (d: string) => ["journal", "append", d, "--file", "-"];

describe("acceptance: kb topology concurrent claim", () => {
  it("acceptance: kb topology concurrent claim windows and server -> first on main wins, loser active_elsewhere", () => {
    const w = makeWorld();
    const win = w.machines.winbox!, srv = w.machines.srvbox!;
    // ikisi de aynı tabandan, kimse diğerinin kaydını görmüyor: iki claim da yerelde başarılı
    win.ok(["active", "claim"]);
    srv.ok(["active", "claim"]);
    expect(srv.activeMachine()).toBe("srvbox");

    // windows main'e ilk iner
    expect(win.ok(["kb", "commit", "claim win", "--push"])).toMatchObject({ pushed: true });
    expect(w.mainFile("active.md")).toMatch(/machine: winbox/);

    // sunucu senkronu: origin/main merge edilir, active.md çakışmasında main kazanır
    const sync = srv.ok(["kb", "sync"]);
    expect(sync).toMatchObject({ merged: true, pushed: true });
    expect(srv.activeMachine()).toBe("winbox");
    expect(w.remoteGit("show", "refs/heads/kb-server:active.md")).toMatch(/machine: winbox/);

    // kaybeden artık salt okunur: kb yazan komut active_elsewhere ile durur, okuma serbest
    expect(srv.fail(JOURNAL("2026-10-25"), { input: "sunucu yazmak istiyor\n" }).error).toMatch(/^active_elsewhere/);
    expect(srv.ok(["active", "show"])).toMatchObject({ mine: false, active: { machine: "winbox" } });

    // sunucu klonu kirli kalmadı, merge yarım bırakılmadı
    expect(srv.git("status", "--porcelain")).toBe("");
    // kazanan taraf main'de duruyor; sunucu dalının inişi active.md'yi değiştirmez
    w.landServerBranchOnMain();
    expect(w.mainFile("active.md")).toMatch(/machine: winbox/);
  });

  it("acceptance: kb topology concurrent claim -> windows push rejected, merged, no lost writes on main", () => {
    const w = makeWorld();
    const win = w.machines.winbox!, srv = w.machines.srvbox!;

    // sunucu önce iner: claim + kendi yazması sync + (promote yerine geçen) iniş ile main'e girer
    srv.ok(["active", "claim"]);
    srv.write("journal/2026-10-26.md", "# sunucu yazması\n");
    srv.ok(["kb", "sync"]);
    w.landServerBranchOnMain();
    expect(w.mainFile("active.md")).toMatch(/machine: srvbox/);
    const mainBefore = w.remoteHead("main")!;

    // windows aynı tabandan (pull etmeden) claim eder ve kendi işini yazar
    win.ok(["active", "claim"]);
    win.write("journal/2026-10-27.md", "# windows yazması\n");
    win.ok(["kb", "commit", "win work"]);
    const winCommit = win.git("rev-parse", "HEAD");

    // push: non-ff reddi -> fetch + merge (rebase yok) + push, active.md çakışmasında main kazanır
    const r = win.run(["kb", "commit", "push", "--push", "--json"]);
    expect(r.code, r.err).toBe(0);
    const res = JSON.parse(r.out);
    expect(res).toMatchObject({ pushed: true });
    expect(`${res.warning ?? ""}\n${r.err}`).toMatch(/active_elsewhere/);

    // kayıp yazma yok: iki tarafın dosyaları da main'de; windows'un kendi commit'i (yeniden yazılmadan) main'in atası
    const mainAfter = w.remoteHead("main")!;
    expect(mainAfter).not.toBe(mainBefore);
    expect(w.mainFile("journal/2026-10-26.md")).toMatch(/sunucu yazması/);
    expect(w.mainFile("journal/2026-10-27.md")).toMatch(/windows yazması/);
    expect(w.remoteGit("merge-base", "--is-ancestor", winCommit, "main")).toBe("");
    expect(w.remoteGit("rev-list", "--parents", "-n1", "main").split(" ")).toHaveLength(3); // merge: iki ebeveyn
    // kazanan: sunucu; kaybeden windows artık salt okunur
    expect(w.mainFile("active.md")).toMatch(/machine: srvbox/);
    expect(win.activeMachine()).toBe("srvbox");
    expect(win.fail(JOURNAL("2026-10-28"), { input: "x\n" }).error).toMatch(/^active_elsewhere/);
  });

  it("acceptance: kb topology same-machine concurrent claim one wins", async () => {
    const w = makeWorld();
    const win = w.machines.winbox!;
    // aynı kb klonunu paylaşan 8 süreç, ayrı makine adlarıyla aynı anda claim eder (withKbLock tek kritik bölüm)
    const names = Array.from({ length: 8 }, (_, i) => `racer${i}`);
    const runs = await Promise.all(names.map((n) => win.runAsync(["active", "claim", "--json"], { env: { VLAD_MACHINE: n } })));
    const winners = runs.map((r, i) => ({ r, n: names[i]! })).filter(({ r }) => r.code === 0);
    expect(winners, runs.map((r) => r.err).join("\n")).toHaveLength(1);
    for (const r of runs) {
      if (r.code === 0) continue;
      expect(r.code).toBe(1);
      expect(JSON.parse(r.err.trim().split("\n").filter(Boolean).pop()!).error).toMatch(/^active_elsewhere/);
    }
    const winner = winners[0]!.n;
    expect(win.activeMachine()).toBe(winner);
    // kayıt bütün: tek makine, bozuk ya da yarım yazılmış değil
    expect(win.ok(["active", "show"], { env: { VLAD_MACHINE: winner } })).toMatchObject({ mine: true, stale: false });
  });
});
