import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import { writeProject } from "../../src/projects/store.js";
import { cleanupTask, removeTaskWorktree, sweepRememberLeftover } from "../../src/tasks/launch.js";
import { createTask, getTask, saveTask } from "../../src/tasks/index.js";
import { pruneOrphanWorktrees } from "../../src/tasks/worktree-prune.js";
import { makeHome, rmTemp } from "../helpers.js";
import { spawnVlad } from "../support/spawn-vlad.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });

let base: string, repo: string, wtRoot: string, cfg: VladConfig, home: string;
beforeEach(() => {
  home = makeHome();
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-prune-")));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  wtRoot = join(base, "wt");
  cfg = defaultConfig();
  cfg.worktreeDir = wtRoot;
  writeProject("alpha", `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
});
afterEach(() => { rmTemp(base); rmTemp(home); });

const task = (state: "done" | "cancelled" | "running" | "queued") => {
  const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "## Tanım\nx\n" });
  t.data.state = state;
  saveTask(t);
  return t.data.id;
};
const leftover = (id: string, files = [".remember/logs/x.log"]) => {
  const d = join(wtRoot, id);
  for (const f of files) { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), "x"); }
  return d;
};

describe("pruneOrphanWorktrees (F-vlad: artık worktree klasörleri)", () => {
  it("varsayılan dry-run: done/cancelled, kayıtsız, görev-ID'li klasörü listeler, silmez", () => {
    const a = leftover(task("done")), b = leftover(task("cancelled"));
    const r = pruneOrphanWorktrees(cfg, { yes: false });
    expect(r.items.filter((i) => i.action === "delete").map((i) => i.dir).sort()).toEqual([a, b].sort());
    expect(r.removed).toBe(0);
    expect(existsSync(a) && existsSync(b)).toBe(true);
  });

  it("--yes: yalnız ölçütlere uyanı siler; running/queued, bilinmeyen görev, ID olmayan ad ve kayıtlı worktree'ye dokunmaz", () => {
    const del = leftover(task("done"));
    const running = leftover(task("running")), queued = leftover(task("queued"));
    const unknown = leftover("T20200101-99");
    const notId = join(wtRoot, "notes"); mkdirSync(notId, { recursive: true }); writeFileSync(join(notId, "f"), "x");
    const regId = task("done");
    git(repo, "worktree", "add", "-b", `vlad/${regId}`, join(wtRoot, regId));
    const r = pruneOrphanWorktrees(cfg, { yes: true });
    expect(r.removed).toBe(1);
    expect(existsSync(del)).toBe(false);
    for (const d of [running, queued, unknown, notId, join(wtRoot, regId)]) expect(existsSync(d), d).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(regId); // kayıt bozulmadı
    expect(r.items.find((i) => i.dir === running)!.reason).toMatch(/running/);
  });

  it("sembolik bağlantı klasörü ve hedefi silinmez (bağlantı izlenmez)", () => {
    const id = task("done");
    const target = join(base, "precious"); mkdirSync(target); writeFileSync(join(target, "k"), "keep");
    mkdirSync(wtRoot, { recursive: true });
    symlinkSync(target, join(wtRoot, id));
    pruneOrphanWorktrees(cfg, { yes: true });
    expect(existsSync(join(target, "k"))).toBe(true);
  });

  it("git worktree list okunamayan (repo yok) projede hiçbir şey silinmez", () => {
    const d = leftover(task("done"));
    rmTemp(join(repo, ".git"));
    const r = pruneOrphanWorktrees(cfg, { yes: true });
    expect(r.removed).toBe(0);
    expect(existsSync(d)).toBe(true);
  });

  it("ASCII dışı (git'in tırnakladığı) yoldaki kayıtlı worktree silinmez (katman 1: -z ile literal karşılaştırma)", () => {
    // newline + ü: git (non -z) quotes such paths ("w\n\303\274") and then samePath cannot match them
    const uRoot = join(base, "w\nü-ç");
    cfg.worktreeDir = uRoot;
    const id = task("done");
    const wt = join(uRoot, id);
    git(repo, "worktree", "add", "-b", `vlad/${id}`, wt);
    // git hâlâ listeler ama içerik yalnız .remember: ölçüt (d) tek başına korumasın, katman 1 kanıtlansın
    for (const n of readdirSync(wt)) if (n !== ".remember") rmSync(join(wt, n), { recursive: true, force: true });
    mkdirSync(join(wt, ".remember"), { recursive: true });
    const r = pruneOrphanWorktrees(cfg, { yes: true });
    expect(r.removed).toBe(0);
    expect(existsSync(wt)).toBe(true);
    expect(r.items.find((i) => i.dir === wt)!.reason).toMatch(/kayıtlı/);
  });

  it("ölçüt (d): .remember dışında içerik varsa dokunulmaz ve 'içerik var' diye listelenir", () => {
    const d = leftover(task("done"), [".remember/logs/x.log", "src/a.ts"]);
    const clean = leftover(task("done"));
    const r = pruneOrphanWorktrees(cfg, { yes: true });
    expect(existsSync(d)).toBe(true);
    expect(existsSync(clean)).toBe(false);
    expect(r.items.find((i) => i.dir === d)).toMatchObject({ action: "skip", reason: expect.stringMatching(/içerik var/) });
  });

  it("paylaşımlı kökte (worktreeDir'de {repo} yok) repo yolu çözülemeyen proje varsa kök güvenli sayılmaz, hiçbir şey silinmez", () => {
    const d = leftover(task("done"));
    writeProject("ghost", `---\nslug: ghost\nname: Ghost\npath: ${JSON.stringify(join(base, "yok"))}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
    const r = pruneOrphanWorktrees(cfg, { yes: true });
    expect(r.removed).toBe(0);
    expect(existsSync(d)).toBe(true);
  });

  it("silme çağrısına klasörün kendi repo'su verilir (kök anahtarından geri aranmaz)", () => {
    const d = leftover(task("done"));
    const seen: string[] = [];
    pruneOrphanWorktrees(cfg, { yes: true }, { remove: (repoArg, dir) => { seen.push(repoArg); removeTaskWorktree(repoArg, dir, "x"); } });
    expect(seen).toEqual([repo]);
    expect(existsSync(d)).toBe(false);
  });

  it("silme hatası diğer klasörleri durdurmaz ve error alanına yazılır", () => {
    const a = leftover(task("done")), b = leftover(task("done"));
    const r = pruneOrphanWorktrees(cfg, { yes: true }, { remove: (_repo, dir) => { if (dir === a) throw new Error("kilitli"); removeTaskWorktree(_repo, dir, "x"); } });
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(false);
    expect(r.items.find((i) => i.dir === a)!.error).toMatch(/kilitli/);
    expect(r.removed).toBe(1);
  });
});

describe("vlad worktree prune CLI: bayraklar", () => {
  const run = (...flags: string[]) => spawnVlad({ args: ["worktree", "prune", "--json", ...flags], env: { VLAD_HOME: home } });
  // varsayılan worktreeDir "{repo}-wt" → <base>/alpha-wt
  const dirOf = (id: string) => join(base, "alpha-wt", id);
  const mk = (id: string) => { mkdirSync(join(dirOf(id), ".remember"), { recursive: true }); return dirOf(id); };

  it("--yes --dry-run birlikte: hiçbir klasör silinmez (--dry-run her zaman kazanır)", () => {
    const id = task("done");
    const d = mk(id);
    const r = run("--yes", "--dry-run");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ dryRun: true, removed: 0 });
    expect(existsSync(d)).toBe(true);
  });
  it("metin çıktısı atlanan klasörleri nedenleriyle listeler (yalnız sayı değil)", () => {
    const idRun = task("running"), idContent = task("done");
    const a = mk(idRun);
    const b = mk(idContent); writeFileSync(join(b, "x.txt"), "x");
    const r = spawnVlad({ args: ["worktree", "prune"], env: { VLAD_HOME: home } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`atlandı: ${a} (${idRun}): görev running`);
    expect(r.stdout).toContain(`atlandı: ${b} (${idContent}): içerik var, atlandı`);
  });
  it("yalnız --yes siler; bayraksız dry-run silmez", () => {
    const id = task("done");
    const d = mk(id);
    expect(run().status).toBe(0);
    expect(existsSync(d)).toBe(true);
    const r = run("--yes");
    expect(JSON.parse(r.stdout)).toMatchObject({ dryRun: false, removed: 1 });
    expect(existsSync(d)).toBe(false);
  });
});

describe("sweepRememberLeftover: .remember artığı (84/84 artık klasör yalnız .remember içeriyordu)", () => {
  it("yalnız .remember içeren klasörü siler; başka içerik varsa dokunmaz", () => {
    const a = leftover("T20261117-01"), b = leftover("T20261117-02", [".remember/logs/x.log", "src/a.ts"]);
    expect(sweepRememberLeftover(a)).toBe(true);
    expect(existsSync(a)).toBe(false);
    expect(sweepRememberLeftover(b)).toBe(false);
    expect(existsSync(join(b, "src", "a.ts"))).toBe(true);
    expect(sweepRememberLeftover(join(wtRoot, "yok"))).toBe(false);
  });
  it("cleanupTask normal worktree'yi kaldırır (kayıt + klasör gider)", () => {
    const id = task("done");
    const wt = join(wtRoot, id);
    git(repo, "worktree", "add", "-b", `vlad/${id}`, wt);
    const t = getTask(id); t.data.worktree = wt; saveTask(t);
    cleanupTask(id, { closeWorker: () => {}, cfg });
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(id);
  });
});
