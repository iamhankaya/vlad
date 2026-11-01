// K10 uzak launch/close/cleanup/resume doğru makinede (+ cleanup güvenliği), K15 yol sözleşmesi, K19 kapı işlemleri (gate-run, merge-preview, merge).
// Kaynak: plan "Uzak launch…", "cleanup güvenliği", "Yol sözleşmesi" + VLAD kararı 19:55 (kapı op'ları; push yok).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { worktreePath } from "../../src/git/git.js";
import { defaultConfig } from "../../src/kb/index.js";
import { front, git, makeWorld, runVlad, type World } from "./machines-world.js";
import { rawCall } from "./machines-raw.js";

let w: World | undefined;
afterEach(async () => { await w?.cleanup(); w = undefined; });
const resp = (o: Awaited<ReturnType<typeof rawCall>>) => { expect(o.kind).toBe("response"); return (o as any).resp; };
const slash = (p: string) => p.split("\\").join("/");
const journal = (side: { home: string }) => {
  const f = join(side.home, ".vlad-agent", "journal.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const ops = (side: { home: string }, op: string) => journal(side).filter((r) => r.op === op);
const claudeJson = (side: { env: Record<string, string> }) => (existsSync(side.env.VLAD_CLAUDE_JSON) ? readFileSync(side.env.VLAD_CLAUDE_JSON, "utf8") : "");
const wtList = (repo: string) => slash(git(repo, "worktree", "list", "--porcelain"));

async function launched() {
  w = await makeWorld({ cardMachines: ["windows"] });
  await w.startAgents(["worker"]);
  const id = await w.newTask();
  const r = await runVlad(w.brain, ["task", "launch", id, "--json"]);
  expect(r.code, r.err).toBe(0);
  const wt = front(w.readTask(w.brain, id), "worktree")!.replace(/^["']|["']$/g, "");
  return { w, id, wt };
}

describe("machines:K — K10 uzak yaşam döngüsü doğru makinede", () => {
  it("launch: worktree + dal + güven kaydı yalnız işçide; beyin repo/claude.json'ında iz yok", async () => {
    const { w, id, wt } = await launched();
    expect(existsSync(wt)).toBe(true);
    expect(slash(wt)).toContain(slash(w.workerRepo) + "-wt/" + id);
    expect(wtList(w.workerRepo)).toContain(id);
    expect(git(w.workerRepo, "branch", "--list", `vlad/${id}`)).toContain(`vlad/${id}`);
    expect(slash(claudeJson(w.worker))).toContain(id);
    expect(claudeJson(w.brain)).not.toContain(id);
    expect(wtList(w.brainRepo)).not.toContain(id);
    expect(git(w.brainRepo, "branch", "--list", `vlad/${id}`).trim()).toBe("");
    expect(existsSync(w.brainRepo + "-wt")).toBe(false);
    expect(w.noop(w.brain)).toHaveLength(0);
    expect(w.noop(w.worker).filter((l) => l.taskId === id)).toHaveLength(1);
    expect(front(w.readTask(w.brain, id), "state")).toBe("running");
    expect(front(w.readTask(w.brain, id), "branch")).toBe(`vlad/${id}`);
  }, 90_000);

  it("close-window ve resume işçi Agent'ına gider (günlükte close/resume, from=brain)", async () => {
    const { w, id } = await launched();
    const c = await runVlad(w.brain, ["task", "close-window", id, "--json"]);
    expect(c.code, c.err).toBe(0);
    expect(ops(w.worker, "close").map((r) => r.from)).toEqual(["mac"]);
    const before = w.noop(w.worker).length;
    const r = await runVlad(w.brain, ["task", "resume", id, "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(ops(w.worker, "resume")).toHaveLength(1);
    expect(w.noop(w.brain)).toHaveLength(0);
    expect(w.noop(w.worker).length).toBeGreaterThanOrEqual(before); // sürdürme beyinde pencere açmaz
    expect(ops(w.brain, "close")).toHaveLength(0);
  }, 90_000);

  it("cleanup: done görev worktree'si işçide silinir ve güven kaydı kalkar; beyindeki aynı adlı dizine dokunulmaz", async () => {
    const { w, id, wt } = await launched();
    const decoy = join(w.brainRepo + "-wt", id); // beyinde aynı göreli yol
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "sentinel.txt"), "dokunma");
    w.setFront(id, { state: "done" });
    const r = await runVlad(w.brain, ["task", "cleanup", id, "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(wtList(w.workerRepo)).not.toContain(id);
    expect(claudeJson(w.worker)).not.toContain(id);
    expect(readFileSync(join(decoy, "sentinel.txt"), "utf8")).toBe("dokunma");
  }, 90_000);

  it("cleanup fail-closed: güven kaydı kaldırılamazsa worktree silinmez", async () => {
    const { w, id, wt } = await launched();
    w.setFront(id, { state: "done" });
    const cj = w.worker.env.VLAD_CLAUDE_JSON;
    // yazılamaz hale getir: dosya yerine dizin
    const { rmSync } = await import("node:fs");
    rmSync(cj, { force: true });
    mkdirSync(cj);
    const r = await runVlad(w.brain, ["task", "cleanup", id]);
    expect(r.code).not.toBe(0);
    expect(existsSync(wt)).toBe(true);
  }, 90_000);

  describe("cleanup güvenliği (doğrudan op, brain anahtarı)", () => {
    const cleanupOp = (world: World, args: object) =>
      rawCall({ port: world.agents.worker!.port, key: world.pair.keys.mac, from: "mac", to: "windows", op: "cleanup", args });

    it("başlatma kaydı olmayan görev, ../ kaçışı, terminal:false, istekteki yol → forbidden/bad_request; hiçbir şey silinmez", async () => {
      const { w, id, wt } = await launched();
      const outside = join(w.base, "kritik");
      mkdirSync(outside);
      writeFileSync(join(outside, "a.txt"), "x");
      const base = { project: w.slug, repoName: w.repoName };
      const attempts: object[] = [
        { ...base, taskId: "T20990101-77", terminal: true },
        { ...base, taskId: `../../${"kritik"}`, terminal: true },
        { ...base, taskId: id, terminal: false },
        { ...base, taskId: id, terminal: true, path: outside },
        { ...base, taskId: id, terminal: true, worktree: outside },
        { project: "../x", repoName: "..", taskId: id, terminal: true },
      ];
      for (const a of attempts) {
        const o = resp(await cleanupOp(w, a));
        expect(["forbidden", "bad_request", "not_found"], JSON.stringify(a)).toContain(o.code);
      }
      expect(existsSync(wt)).toBe(true);
      expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("x");
    }, 90_000);

    it("bayat/oynanmış başlatma kaydı (yol kök dışına işaret ediyor) → forbidden, hedef dizin silinmez", async () => {
      const { w, id, wt } = await launched();
      const outside = join(w.base, "kritik2");
      mkdirSync(outside);
      writeFileSync(join(outside, "a.txt"), "x");
      const rec = join(w.worker.home, ".vlad-agent", "launches", `${id}.json`);
      expect(existsSync(rec), "launch kaydı .vlad-agent/launches/<id>.json").toBe(true);
      const txt = readFileSync(rec, "utf8").split(JSON.stringify(wt).slice(1, -1)).join(JSON.stringify(outside).slice(1, -1));
      writeFileSync(rec, txt);
      const o = resp(await cleanupOp(w, { project: w.slug, repoName: w.repoName, taskId: id, terminal: true }));
      expect(o.code).toBe("forbidden");
      expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("x");
      expect(existsSync(wt)).toBe(true);
    }, 90_000);

    it("worker/konsol kimlikleri cleanup/launch/close çağıramaz", async () => {
      const { w, id } = await launched();
      for (const [from, key] of [["windows", w.pair.keys.windows], ["desktop", w.pair.keys.desktop]] as const) {
        for (const op of ["cleanup", "close", "launch"]) {
          const o = resp(await rawCall({ port: w.agents.worker!.port, key, from, to: "windows", op, args: { taskId: id } }));
          expect(o.code, `${from}/${op}`).toBe("forbidden");
        }
      }
    }, 90_000);
  });
});

describe("machines:K — K15 yol sözleşmesi", () => {
  const cfg = defaultConfig();
  const wp = worktreePath as unknown as (c: unknown, repo: string, id: string, os?: string) => string; // 4. parametre A fazında eklenir
  it("worktreePath: win32 çıktısı mevcut biçimle bayt bayt aynı; posix '/' ayracı", () => {
    expect(wp(cfg, "C:\\dev\\alpha", "T20261101-01", "win32")).toBe("C:\\dev\\alpha-wt\\T20261101-01");
    expect(wp(cfg, "/Users/m/dev/alpha", "T20261101-01", "darwin")).toBe("/Users/m/dev/alpha-wt/T20261101-01");
    if (process.platform === "win32") expect(wp(cfg, "C:\\dev\\alpha", "T20261101-01")).toBe("C:\\dev\\alpha-wt\\T20261101-01");
  });
  it("repoNameOf: win→posix ve posix→win kart yolundan yalnız ad çıkar", async () => {
    const mod: any = await import(["..", "..", "src", "machines", "paths.js"].join("/"));
    expect(mod.repoNameOf("C:\\dev\\alpha")).toBe("alpha");
    expect(mod.repoNameOf("C:/dev/alpha")).toBe("alpha");
    expect(mod.repoNameOf("/Users/m/dev/alpha")).toBe("alpha");
    expect(mod.repoNameOf("/Users/m/dev/alpha/")).toBe("alpha");
  });
  it("iki kökte aynı ad: conflict 'belirsiz repo adı'; launch edilmez, rezervasyon temizlenir", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    const root2 = join(w.base, "roots-windows-2");
    mkdirSync(join(root2, w.repoName), { recursive: true });
    git(join(root2, w.repoName), "init", "-q", "-b", "main");
    writeFileSync(join(root2, w.repoName, "f"), "x");
    git(join(root2, w.repoName), "add", "-A"); git(join(root2, w.repoName), "commit", "-q", "-m", "i");
    const cfg2 = w.config() as any;
    cfg2.machines[1].roots.push(root2);
    for (const s of [w.brain, w.worker]) writeFileSync(join(s.home, "vlad.config.json"), JSON.stringify(cfg2));
    w.config = () => cfg2; // setPorts yeniden yazarken kök listesi korunsun
    await w.startAgents(["worker"]);
    const id = await w.newTask();
    const r = await runVlad(w.brain, ["task", "launch", id]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("belirsiz repo adı");
    expect(w.noop(w.worker)).toHaveLength(0);
    expect(front(w.readTask(w.brain, id), "state")).toBe("queued");
    expect(front(w.readTask(w.brain, id), "launch_op") ?? "null").toBe("null");
  }, 90_000);
  it("işçide repo yok: not_found 'repo yok: <ad>'", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    const { rmSync } = await import("node:fs");
    rmSync(w.workerRepo, { recursive: true, force: true });
    await w.startAgents(["worker"]);
    const id = await w.newTask();
    const r = await runVlad(w.brain, ["task", "launch", id]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`repo yok: ${w.repoName}`);
    expect(w.noop(w.worker)).toHaveLength(0);
    expect(front(w.readTask(w.brain, id), "machine_reserved") ?? "null").toBe("null"); // kesin hata: rezervasyon bırakıldı
  }, 90_000);
});

describe("machines:K — K19 kapı işlemleri (uzak makinede gate-run / merge-preview / merge; push yok)", () => {
  const GATE = `node -e "console.log('GATE-OK ' + process.cwd())"`;
  async function pipelineOnWindows() {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    const set = await runVlad(w.brain, ["project", "set", w.slug, "gate", GATE]);
    expect(set.code, set.err).toBe(0);
    const pr = await runVlad(w.brain, ["task", "new", "--project", w.slug, "--title", "P", "--kind", "pipeline", "--body-file", "-", "--json"], { stdin: "## Tanım\np\n" });
    const pid = JSON.parse(pr.out).id as string;
    const phase = await w.newTask({ args: ["--parent", pid, "--phase", "uygulama"] });
    const l = await runVlad(w.brain, ["task", "launch", phase, "--json"]);
    expect(l.code, l.err).toBe(0);
    const wt = front(w.readTask(w.brain, phase), "worktree")!.replace(/^["']|["']$/g, "");
    // faz dalında bir commit; kb (gate komutu kartta) işçiye eşitlenir
    writeFileSync(join(wt, "faz.txt"), "faz değişikliği\n");
    git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", "faz");
    const c = await runVlad(w.brain, ["kb", "commit", "gate", "--push"]);
    expect(c.code, c.err).toBe(0);
    const sha = git(w.brain.kb, "rev-parse", "HEAD").trim();
    const sync = resp(await rawCall({ port: w.agents.worker!.port, key: w.pair.keys.mac, from: "mac", to: "windows", op: "kb-sync", args: { expectSha: sha } }));
    expect(sync.code, JSON.stringify(sync)).toBe("ok");
    return { w, pid, phase, wt };
  }
  const op = (world: World, name: string, args: object, k = "mac") =>
    rawCall({ port: world.agents.worker!.port, key: world.pair.keys[k], from: k, to: "windows", op: name, args });

  it("merge-preview yazmaz; gate-run entegrasyon worktree'sinde kartın gate komutunu koşar; merge entegrasyona alır, push yok", async () => {
    const { w, pid, phase } = await pipelineOnWindows();
    const base = { project: w.slug, repoName: w.repoName };
    const integ = `vlad/${pid}`;
    const headBefore = git(w.workerRepo, "rev-parse", integ).trim();
    const pv = resp(await op(w, "merge-preview", { ...base, taskId: phase, from: `vlad/${phase}`, into: integ }));
    expect(pv.code, JSON.stringify(pv)).toBe("ok");
    expect(pv.result.diffStat).toContain("faz.txt");
    expect(pv.result.conflicts).toEqual([]);
    expect(git(w.workerRepo, "rev-parse", integ).trim()).toBe(headBefore); // yazmadı

    const m = resp(await op(w, "merge", { ...base, taskId: phase, from: `vlad/${phase}`, into: integ, message: "faz kapısı" }));
    expect(m.code, JSON.stringify(m)).toBe("ok");
    expect(m.result.merged).toBe(true);
    expect(git(w.workerRepo, "rev-parse", integ).trim()).toBe(m.result.head);
    expect(git(w.workerRepo, "ls-tree", "-r", "--name-only", integ)).toContain("faz.txt");
    expect(git(w.workerRepo, "remote").trim()).toBe(""); // push edecek uzak yok
    expect(git(w.brainRepo, "branch", "--list", integ).trim()).toBe(""); // beyindeki repoya dokunulmadı

    const g = resp(await op(w, "gate-run", { ...base, taskId: phase, target: "integration" }));
    expect(g.code, JSON.stringify(g)).toBe("ok");
    expect(g.result.exit).toBe(0);
    expect(slash(g.result.stdout)).toContain(`GATE-OK`);
    expect(slash(g.result.stdout)).toContain(`${slash(w.workerRepo)}-wt/${pid}`);
  }, 120_000);

  it("kırmızı gate: exit != 0 sonuçta döner (op başarılı, sonuç kırmızı)", async () => {
    const { w, phase } = await pipelineOnWindows();
    await runVlad(w.brain, ["project", "set", w.slug, "gate", `node -e "console.error('KIRMIZI');process.exit(3)"`]);
    await runVlad(w.brain, ["kb", "commit", "gate-kirmizi", "--push"]);
    const sha = git(w.brain.kb, "rev-parse", "HEAD").trim();
    await op(w, "kb-sync", { expectSha: sha });
    const g = resp(await op(w, "gate-run", { project: w.slug, repoName: w.repoName, taskId: phase, target: "task" }));
    expect(g.code).toBe("ok");
    expect(g.result.exit).toBe(3);
    expect(g.result.stderr).toContain("KIRMIZI");
  }, 120_000);

  it("kötü ref/yol: baştaki '-', boşluk, ';', '..' → bad_request; hiçbir şey çalışmaz/yazılmaz", async () => {
    const { w, pid, phase } = await pipelineOnWindows();
    const base = { project: w.slug, repoName: w.repoName, taskId: phase };
    const head = git(w.workerRepo, "rev-parse", `vlad/${pid}`).trim();
    for (const bad of ["--upload-pack=calc", "-x", "a b", "a;rm -rf x", "../etc", `vlad/${phase} --no-ff`]) {
      for (const [name, args] of [["merge-preview", { ...base, from: bad, into: `vlad/${pid}` }], ["merge", { ...base, from: `vlad/${phase}`, into: bad }], ["merge", { ...base, from: bad, into: `vlad/${pid}` }]] as const) {
        const o = resp(await op(w, name, args));
        expect(["bad_request", "forbidden", "not_found"], `${name} ${bad}`).toContain(o.code);
      }
    }
    expect(git(w.workerRepo, "rev-parse", `vlad/${pid}`).trim()).toBe(head);
  }, 120_000);

  it("başka makinenin görevi / başlatma kaydı olmayan görev için kapı op'ları forbidden/not_found; worker ve konsol kimliği yasak", async () => {
    const { w, phase, pid } = await pipelineOnWindows();
    const base = { project: w.slug, repoName: w.repoName };
    const o1 = resp(await op(w, "gate-run", { ...base, taskId: "T20990101-77", target: "task" }));
    expect(["forbidden", "not_found"]).toContain(o1.code);
    w.setFront(phase, { machine: "mac" });
    const o2 = resp(await op(w, "merge", { ...base, taskId: phase, from: `vlad/${phase}`, into: `vlad/${pid}` }));
    expect(["forbidden", "not_found"]).toContain(o2.code);
    for (const [k, name] of [["windows", "gate-run"], ["desktop", "merge"], ["desktop", "merge-preview"]] as const) {
      const o = resp(await op(w, name, { ...base, taskId: phase, target: "task", from: "a", into: "b" }, k));
      expect(o.code, `${k}/${name}`).toBe("forbidden");
    }
  }, 120_000);
});
