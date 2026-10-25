// T13 kabul (T20261025-90): sunucu tarafı akışlar, gerçek `promoteKb` ile. Kaynak: topoloji notu K4, K5, K8, #### Test stratejisi -> T13.
//  - "server read-only after windows retakes -> API write 409, worker writes still reach main"
//  - "non-kb file in kb-server never reaches main"
// S13b (`kb sync`) ve S13c (`promoteKb`) uygulanana kadar kırmızı kalabilir.
import { describe, expect, it } from "vitest";
import { classifyVladError } from "../../src/vlad/cli.ts";
import { makeWorld, newRunningTask, taskRel } from "../helpers/kbRepos.ts";
import { makePromoteEnv } from "../helpers/kbPromote.ts";

describe("acceptance: kb topology server", () => {
  it("acceptance: kb topology server read-only after windows retakes -> API write 409, worker writes still reach main", async () => {
    const w = makeWorld();
    const win = w.machines.winbox!, srv = w.machines.srvbox!;
    const env = makePromoteEnv(w);

    // sunucu etkin; çalışan bir görev var; ikisi de gerçek promote ile main'e iner
    srv.ok(["active", "claim"]);
    const id = newRunningTask(srv);
    srv.ok(["kb", "sync"]);
    expect(await env.run()).toMatchObject({ promoted: true });
    expect(w.mainFile("active.md")).toMatch(/machine: srvbox/);

    // windows devralır ve main'e yazar
    win.ok(["kb", "pull"]);
    win.ok(["active", "claim", "--takeover"]);
    win.ok(["kb", "commit", "windows geri aldı", "--push"]);
    expect(w.mainFile("active.md")).toMatch(/machine: winbox/);

    // sunucu bir sonraki senkronda bunu görür: salt okunur
    srv.ok(["kb", "sync"]);
    expect(srv.activeMachine()).toBe("winbox");

    // API yazması (runVlad -> CLI) active_elsewhere alır; sunucu bunu 409'a çevirir (server/src/vlad/cli.ts kind eşlemesi)
    const apiWrite = srv.run(["journal", "append", "2026-10-26", "--file", "-", "--json"], { input: "api yazması\n" });
    expect(apiWrite.code).toBe(1);
    expect(classifyVladError(apiWrite.err).kind).toBe("active_elsewhere");
    expect(srv.exists("journal/2026-10-26.md")).toBe(false);

    // çalışan yazması muafiyetle sürer ve kbsync + promote ile main'e ulaşır
    srv.ok(["task", "log", id, "etkin olmayan sunucuda çalışan satırı"], { env: { VLAD_TASK_ID: id } });
    const sync = srv.ok<{ pushed: boolean }>(["kb", "sync"]);
    expect(sync.pushed).toBe(true);
    const r = await env.run();
    expect(r, JSON.stringify(r)).toMatchObject({ promoted: true });
    const rel = taskRel(srv, id);
    expect(w.mainFile(rel)).toMatch(/etkin olmayan sunucuda çalışan satırı/);
    // windows'un takeover'ı geri alınmadı
    expect(w.mainFile("active.md")).toMatch(/machine: winbox/);
    // windows çalışanın satırını pull ile görür
    win.ok(["kb", "pull"]);
    expect(win.read(rel)).toMatch(/etkin olmayan sunucuda çalışan satırı/);
  });

  it("acceptance: kb topology non-kb file in kb-server never reaches main", async () => {
    const w = makeWorld();
    const win = w.machines.winbox!, srv = w.machines.srvbox!;
    const env = makePromoteEnv(w);
    const mainBefore = w.remoteHead("main")!;

    // sunucu ajanı kb dışı dosyalar bırakır; ayrıca meşru bir yazma da vardır
    srv.write("src/evil.ts", "process.exit(1)\n");
    srv.write(".github/workflows/steal.yml", "on: push\n");
    srv.write("journal/2026-10-26.md", "# meşru\n");
    srv.ok(["kb", "sync"]); // kb-server'a gider (kapı promote'tur, sync değil)
    expect(w.remoteGit("show", "refs/heads/kb-server:src/evil.ts")).toMatch(/process\.exit/);

    for (let i = 0; i < 2; i++) { // tekrar koşular da aynı sonucu verir
      const r = await env.run();
      expect(r.promoted).toBe(false);
      expect(r.reason).toBe("rejected");
      const paths = (r.violations ?? []).map((v) => v.path);
      expect(paths).toEqual(expect.arrayContaining(["src/evil.ts", ".github/workflows/steal.yml"]));
      expect(w.remoteHead("main")).toBe(mainBefore);
    }
    // main'in hiçbir revizyonunda kb dışı yol yok; meşru yazma da (hepsi ya da hiçbiri) inmedi
    expect(w.remoteGit("log", "--format=", "--name-only", "main").split("\n").filter(Boolean).sort()).toEqual(
      [".gitignore", "decisions.md", "journal/2026-10-25.md", "projects/alpha.md"],
    );
    expect(w.mainFile("journal/2026-10-26.md")).toBeNull();
    expect(env.writes).toEqual([]);
    expect(env.cards.length).toBeGreaterThanOrEqual(1);
    // windows pull ile hiçbir şey almaz
    win.ok(["kb", "pull"]);
    expect(win.exists("src/evil.ts")).toBe(false);
    expect(win.exists(".github")).toBe(false);
  });
});
