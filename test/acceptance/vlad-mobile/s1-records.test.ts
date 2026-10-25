// T1 kabul: S1a/S1b/S1c — görev alanları, config makine katmanı, minCliVersion, makine yolu, klon, kilit.
// Kaynak: docs/plan/vlad-mobile-plan.md §Arayüzler (task/project/config), §S1a, §S1b, §S1c. Üretim koduna bakılmadan yazıldı.
// Platform notu: Linux'ta `auto` launcher S2a'ya kadar `process` değildir; launch testleri `wt` launcher'ını --dry-run ile kullanır
// (gerçek terminal açılmaz) ve yalnız yol/host sözleşmesini sınar.
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MACHINE, fail, getTask, gitRepo, kbFiles, newHome, newTask, ok, run, runAsync, sha40, tmp, writeConfig, writeProjectCard,
} from "./helpers.js";

let home: string;
beforeEach(() => { home = newHome(); writeProjectCard(home); });

describe("records: task progress (S1a alan / S1b komut)", () => {
  it("task accepts progress {pct,label,at} and shows it in --json", () => {
    const id = newTask(home);
    ok(home, ["task", "progress", id, "--pct", "40", "--label", "testler yazılıyor"]);
    const t = getTask(home, id);
    expect(t.progress.pct).toBe(40);
    expect(t.progress.label).toBe("testler yazılıyor");
    expect(typeof t.progress.at).toBe("string");
    expect(Number.isNaN(Date.parse(t.progress.at))).toBe(false);
  });
  it("progress without --pct means indeterminate (pct null)", () => {
    const id = newTask(home);
    ok(home, ["task", "progress", id, "--label", "belirsiz"]);
    expect(getTask(home, id).progress.pct).toBeNull();
  });
  it("progress boundaries 0 and 100 accepted", () => {
    const id = newTask(home);
    for (const p of ["0", "100"]) {
      ok(home, ["task", "progress", id, "--pct", p, "--label", "x"]);
      expect(getTask(home, id).progress.pct).toBe(Number(p));
    }
  });
  it("task rejects progress.pct 101 (error key, exit 1)", () => {
    const id = newTask(home);
    fail(home, ["task", "progress", id, "--pct", "101", "--label", "x"]);
    expect(getTask(home, id).progress ?? null).toBeNull();
  });
  it.each(["-1", "1.5", "abc", "1e2"])("task rejects progress.pct %s", (bad) => {
    const id = newTask(home);
    fail(home, ["task", "progress", id, "--pct", bad, "--label", "x"]);
  });
  it("progress requires --label", () => {
    const id = newTask(home);
    fail(home, ["task", "progress", id, "--pct", "10"]);
  });
  it("progress on unknown task id errors", () => {
    fail(home, ["task", "progress", "T19990101-01", "--pct", "1", "--label", "x"]);
  });
  it("latest progress replaces the previous one", () => {
    const id = newTask(home);
    ok(home, ["task", "progress", id, "--pct", "10", "--label", "a"]);
    ok(home, ["task", "progress", id, "--pct", "20", "--label", "b"]);
    const p = getTask(home, id).progress;
    expect([p.pct, p.label]).toEqual([20, "b"]);
  });
  it("label with Turkish characters and shell metacharacters is stored verbatim", () => {
    const id = newTask(home);
    const label = "İşlem; $(rm -rf /) `x` ığüşöç \"q\" 'q'";
    ok(home, ["task", "progress", id, "--pct", "5", "--label", label]);
    expect(getTask(home, id).progress.label).toBe(label);
  });
});

describe("records: task pr (S1a alan / S1b komut)", () => {
  it("task accepts pr {number, repo, base, url?} and shows it in --json", () => {
    const id = newTask(home);
    ok(home, ["task", "pr", id, "--number", "42", "--repo", "acme/alpha", "--base", "vlad/T20261024-94", "--url", "https://github.com/acme/alpha/pull/42"]);
    const pr = getTask(home, id).pr;
    expect(pr.number).toBe(42);
    expect(pr.repo).toBe("acme/alpha");
    expect(pr.base).toBe("vlad/T20261024-94");
    expect(pr.url).toBe("https://github.com/acme/alpha/pull/42");
  });
  it("pr without --url is accepted", () => {
    const id = newTask(home);
    ok(home, ["task", "pr", id, "--number", "1", "--repo", "acme/alpha", "--base", "main"]);
    expect(getTask(home, id).pr.number).toBe(1);
  });
  it.each(["noslash", "a/b/c", "", "acme/"])("pr rejects repo %j (owner/name biçimi)", (repo) => {
    const id = newTask(home);
    fail(home, ["task", "pr", id, "--number", "1", "--repo", repo, "--base", "main"]);
  });
  it.each(["abc", "1.5", "-3"])("pr rejects number %s", (n) => {
    const id = newTask(home);
    fail(home, ["task", "pr", id, "--number", n, "--repo", "acme/alpha", "--base", "main"]);
  });
  it("pr requires number, repo and base", () => {
    const id = newTask(home);
    fail(home, ["task", "pr", id, "--repo", "acme/alpha", "--base", "main"]);
    fail(home, ["task", "pr", id, "--number", "1", "--base", "main"]);
    fail(home, ["task", "pr", id, "--number", "1", "--repo", "acme/alpha"]);
  });
});

describe("records: config machines overlay + minCliVersion (S1a)", () => {
  it("config machines overlay: maxParallel of the current machine wins over the global value", () => {
    writeConfig(home, { maxParallel: 5, machines: { [MACHINE]: { maxParallel: 1 }, other: { maxParallel: 3 } } });
    expect(ok<any>(home, ["task", "ready"]).maxParallel).toBe(1);
    expect(ok<any>(home, ["task", "ready"], { env: { VLAD_MACHINE: "other" } }).maxParallel).toBe(3);
    expect(ok<any>(home, ["task", "ready"], { env: { VLAD_MACHINE: "unlisted" } }).maxParallel).toBe(5);
  });
  it("config machines: unknown machine key falls back to global config", () => {
    writeConfig(home, { maxParallel: 4, machines: { someoneelse: { maxParallel: 1 } } });
    expect(ok<any>(home, ["task", "ready"]).maxParallel).toBe(4);
  });
  it("config machine name must match ^[A-Za-z0-9._-]+$", () => {
    writeConfig(home, { machines: { "bad name!": { maxParallel: 1 } } });
    fail(home, ["task", "ready"]);
  });
  it("config machines entries reject unknown properties and bad maxParallel", () => {
    writeConfig(home, { machines: { [MACHINE]: { nope: 1 } } });
    fail(home, ["task", "ready"]);
    writeConfig(home, { machines: { [MACHINE]: { maxParallel: 0 } } });
    fail(home, ["task", "ready"]);
  });
  it("old cli rejected by minCliVersion on every command (message starts 'VLAD CLI çok eski')", () => {
    writeConfig(home, { minCliVersion: "999.0.0" });
    for (const args of [["task", "list"], ["card", "list"], ["quota", "show"], ["vault", "ls"], ["audit", "list"], ["project", "list"]]) {
      const e = fail(home, args);
      expect(e.error, args.join(" ")).toMatch(/^VLAD CLI çok eski/);
      expect(e.error).toContain("999.0.0");
    }
  });
  it("minCliVersion at or below the installed version is accepted", () => {
    writeConfig(home, { minCliVersion: "0.0.1" });
    ok(home, ["task", "list"]);
  });
  // KIRMIZI BIRAKILDI (rapor: Kırmızı bırakılan testler #1): bozuk `minCliVersion` ("yeni", "1.x", "0.1") sürüm kapısını sessizce
  // devre dışı bırakır (fail-open). Plan S1a: "her komut başında kontrol eder"; bozuk değerin kabulü eski-CLI korumasını deler.
  it("minCliVersion must be x.y.z (malformed value must not silently disable the gate)", () => {
    for (const bad of ["yeni", "1.x", "0.1"]) {
      writeConfig(home, { minCliVersion: bad });
      fail(home, ["task", "list"]);
    }
  });
});

describe("launcher: worktree yolu ve host (S1a/S1b, Linux)", () => {
  let base: string, repo: string;
  beforeEach(() => {
    base = tmp("vlad-s1-");
    repo = gitRepo(join(base, "alpha"));
    // kartın `path`'i bu makinede geçersiz; doğru yol `paths.<makine>`'den gelmeli
    writeProjectCard(home, "alpha", { path: "/nonexistent/windows-box/alpha" });
    ok(home, ["project", "path", "alpha", repo, "--keep", "winbox"]);
  });

  it("launch --dry-run on linux: worktree absolute, no backslash, under worktreeDir", () => {
    const wt = join(base, "wt");
    writeConfig(home, { worktreeDir: wt, launcher: "wt" });
    const id = newTask(home);
    const r = ok<any>(home, ["task", "launch", id, "--dry-run"]);
    expect(isAbsolute(r.worktree)).toBe(true);
    expect(r.worktree).not.toContain("\\");
    expect(r.worktree.startsWith(wt + "/")).toBe(true);
  });
  it("launch with {repo} template resolves to a forward-slash absolute path", () => {
    writeConfig(home, { worktreeDir: "{repo}-wt", launcher: "wt" });
    const id = newTask(home);
    const r = ok<any>(home, ["task", "launch", id, "--dry-run"]);
    expect(isAbsolute(r.worktree)).toBe(true);
    expect(r.worktree).not.toContain("\\");
    expect(r.worktree.startsWith(`${repo}-wt/`)).toBe(true);
  });
  it("windows-style worktreeDir rejected on linux with explicit error (error key, exit 1)", () => {
    writeConfig(home, { worktreeDir: "C:\\wt\\{repo}", launcher: "wt" });
    const id = newTask(home);
    const e = fail(home, ["task", "launch", id, "--dry-run"]);
    expect(e.error).toMatch(/worktreeDir/);
  });
  it("machines.<ad>.worktreeDir overrides a windows-style global worktreeDir", () => {
    const wt = join(base, "wt2");
    writeConfig(home, { worktreeDir: "C:\\wt", launcher: "wt", machines: { [MACHINE]: { worktreeDir: wt } } });
    const id = newTask(home);
    const r = ok<any>(home, ["task", "launch", id, "--dry-run"]);
    expect(r.worktree.startsWith(wt + "/")).toBe(true);
  });
  it("records: launch writes host (current machine) to the task", () => {
    writeConfig(home, { worktreeDir: join(base, "wt3"), launcher: "wt" });
    const id = newTask(home);
    expect(getTask(home, id).host ?? null).toBeNull();
    ok(home, ["task", "launch", id, "--dry-run"]);
    expect(getTask(home, id).host).toBe(MACHINE);
  });
  it("records: launch uses the per-machine project path, not the card's foreign path", () => {
    writeConfig(home, { worktreeDir: join(base, "wt4"), launcher: "wt" });
    const id = newTask(home);
    ok(home, ["task", "launch", id, "--dry-run"]);
    const wtList = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
    expect(wtList).toContain(id);
  });
  it("launch on a machine without a clone fails pointing to `vlad project clone alpha`", () => {
    writeConfig(home, { worktreeDir: join(base, "wt5"), launcher: "wt" });
    const id = newTask(home);
    const e = fail(home, ["task", "launch", id, "--dry-run"], { env: { VLAD_MACHINE: "empty-box" } });
    expect(e.error).toContain("vlad project clone alpha");
  });
  it("launch --json exposes the new fields on the task afterwards (progress/pr/host keys present)", () => {
    writeConfig(home, { worktreeDir: join(base, "wt6"), launcher: "wt" });
    const id = newTask(home);
    ok(home, ["task", "launch", id, "--dry-run"]);
    ok(home, ["task", "progress", id, "--pct", "1", "--label", "a"]);
    ok(home, ["task", "pr", id, "--number", "3", "--repo", "acme/alpha", "--base", "main"]);
    const t = getTask(home, id);
    expect(t).toMatchObject({ host: MACHINE, progress: { pct: 1 }, pr: { number: 3 } });
  });
});

describe("records: project path per machine + clone (S1a/S1b)", () => {
  it("first record needs --keep <machine> naming the owner of the existing path", () => {
    const e = fail(home, ["project", "path", "alpha", "/some/where"]);
    expect(e.error).toContain("--keep");
  });
  it("project path per machine: stored and read per machine, path stays required", () => {
    ok(home, ["project", "path", "alpha", "/win/dev/alpha", "--keep", "winbox"]);
    ok(home, ["project", "path", "alpha", "/srv/alpha", "--machine", "srv"]);
    expect(ok<any>(home, ["project", "path", "alpha", "--machine", "winbox"]).path).toBe("/nonexistent/alpha");
    expect(ok<any>(home, ["project", "path", "alpha", "--machine", "srv"]).path).toBe("/srv/alpha");
  });
  it("project path for this machine defaults to VLAD_MACHINE", () => {
    ok(home, ["project", "path", "alpha", "/here/alpha", "--keep", "winbox"]);
    const r = ok<any>(home, ["project", "path", "alpha"]);
    expect(r).toMatchObject({ slug: "alpha", machine: MACHINE, path: "/here/alpha" });
  });
  it("machine without a recorded clone: error says `vlad project clone <slug>` (stable error key)", () => {
    ok(home, ["project", "path", "alpha", "/win/dev/alpha", "--keep", "winbox"]); // paths oluştu; kayıtsız makine artık "klon yok"
    const e = fail(home, ["project", "path", "alpha", "--machine", "ghost"]);
    expect(e.error).toContain("bu makinede klon yok: alpha");
    expect(e.error).toContain("vlad project clone alpha");
  });
  it("project path rejects machine names outside ^[A-Za-z0-9._-]+$", () => {
    fail(home, ["project", "path", "alpha", "/x", "--machine", "bad name", "--keep", "winbox"]);
    fail(home, ["project", "path", "alpha", "/x", "--machine", "../evil", "--keep", "winbox"]);
  });
  it("project path on unknown project errors", () => {
    fail(home, ["project", "path", "nope", "/x", "--keep", "winbox"]);
  });

  it("records: project clone from local bare repo", () => {
    const base = tmp("vlad-clone-");
    const src = gitRepo(join(base, "src"));
    const bare = join(base, "bare.git");
    execFileSync("git", ["clone", "-q", "--bare", src, bare]);
    const dest = join(base, "clones", "alpha");
    const r = ok<any>(home, ["project", "clone", "alpha", "--from", bare, "--to", dest, "--keep", "winbox"]);
    expect(existsSync(join(dest, ".git"))).toBe(true);
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("1");
    expect(JSON.stringify(r)).toContain(dest);
    expect(ok<any>(home, ["project", "path", "alpha"]).path).toBe(dest);
  });
  it("project clone uses <roots[0]>/<slug> by default", () => {
    const base = tmp("vlad-clone-");
    const src = gitRepo(join(base, "src"));
    const bare = join(base, "bare.git");
    execFileSync("git", ["clone", "-q", "--bare", src, bare]);
    const root = join(base, "roots");
    mkdirSync(root);
    writeConfig(home, { roots: [root] });
    ok(home, ["project", "clone", "alpha", "--from", bare, "--keep", "winbox"]);
    expect(existsSync(join(root, "alpha", ".git"))).toBe(true);
    expect(ok<any>(home, ["project", "path", "alpha"]).path).toBe(join(root, "alpha"));
  });
  it("project clone twice refuses (clone already exists) and keeps the recorded path", () => {
    const base = tmp("vlad-clone-");
    const src = gitRepo(join(base, "src"));
    const bare = join(base, "bare.git");
    execFileSync("git", ["clone", "-q", "--bare", src, bare]);
    const dest = join(base, "c");
    ok(home, ["project", "clone", "alpha", "--from", bare, "--to", dest, "--keep", "winbox"]);
    fail(home, ["project", "clone", "alpha", "--from", bare, "--to", join(base, "c2")]);
    expect(ok<any>(home, ["project", "path", "alpha"]).path).toBe(dest);
  });
  it("project clone from an unreachable source fails and records no path", () => {
    const base = tmp("vlad-clone-");
    fail(home, ["project", "clone", "alpha", "--from", join(base, "yok.git"), "--to", join(base, "c"), "--keep", "winbox"]);
    expect(existsSync(join(base, "c", ".git"))).toBe(false);
    // başarısız klon bu makine için yol kaydetmemeli: kayıt yok -> kartın eski `path`'i (tek makine uyumu) değişmeden kalır
    expect(ok<any>(home, ["project", "path", "alpha"]).path).not.toBe(join(base, "c"));
  });
  it("project clone into a non-empty existing directory is refused", () => {
    const base = tmp("vlad-clone-");
    const src = gitRepo(join(base, "src"));
    const bare = join(base, "bare.git");
    execFileSync("git", ["clone", "-q", "--bare", src, bare]);
    const dest = join(base, "occupied");
    mkdirSync(dest);
    writeFileSync(join(dest, "keep.txt"), "x");
    fail(home, ["project", "clone", "alpha", "--from", bare, "--to", dest, "--keep", "winbox"]);
    expect(readFileSync(join(dest, "keep.txt"), "utf8")).toBe("x");
  });
});

describe("records: kb lock — withKbLock (S1c)", () => {
  const lockFile = () => join(home, "kb", ".vlad.lock");
  const audit = (n: number) => JSON.stringify({
    ts: new Date().toISOString(), action_id: `A-lock-${n}`, kind: "merge_phase", repo: "acme/alpha", pr: 1,
    head_sha: sha40(), approver: { type: "device", id: "d1" }, result: "merged",
  });

  it("records: 50 concurrent audit-like writes no interleave (two writer processes)", async () => {
    const writers = [0, 1].map((w) => new Promise<number[]>((resolve) => {
      const codes: number[] = [];
      let i = 0;
      const next = () => {
        if (i === 25) return resolve(codes);
        const n = w * 25 + i++;
        const file = join(tmp("vlad-a-"), "a.json");
        writeFileSync(file, audit(n));
        runAsync(home, ["audit", "add", "--file", file, "--json"]).then((r) => { codes.push(r.code ?? -1); next(); });
      };
      next();
    }));
    const codes = (await Promise.all(writers)).flat();
    expect(codes.filter((c) => c !== 0)).toEqual([]);
    const list = ok<any>(home, ["audit", "list"]);
    expect(list.warnings).toEqual([]);
    expect(new Set(list.entries.map((e: any) => e.action_id)).size).toBe(50);
    expect(existsSync(lockFile())).toBe(false);
  }, 120_000);

  it("records: 20 truly parallel writers also finish without corrupt lines", async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, n) => {
      const file = join(tmp("vlad-a-"), "a.json");
      writeFileSync(file, audit(1000 + n));
      return runAsync(home, ["audit", "add", "--file", file, "--json"]);
    }));
    expect(rs.filter((r) => r.code !== 0).map((r) => r.err)).toEqual([]);
    const list = ok<any>(home, ["audit", "list"]);
    expect(list.warnings).toEqual([]);
    expect(list.entries).toHaveLength(20);
  }, 120_000);

  it("records: stale lock recovered (dead pid, older than 60 s)", () => {
    writeFileSync(lockFile(), "2147483646\n");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockFile(), old, old);
    const f = join(tmp("vlad-a-"), "a.json");
    writeFileSync(f, audit(1));
    ok(home, ["audit", "add", "--file", f]);
    expect(existsSync(lockFile())).toBe(false);
  });

  it("records: lock wait timeout error kb-meşgul (fresh lock held by a live process) on writing commands, reads unaffected", async () => {
    writeFileSync(lockFile(), `${process.pid}\n`);
    // okuyan komutlar kilide takılmaz
    ok(home, ["task", "list"]);
    ok(home, ["card", "list"]);
    ok(home, ["audit", "list"]);
    ok(home, ["quota", "show"]);
    // yazan komutlar ~10 sn bekler, sonra `kb meşgul` ile çıkış 1 (süre eşiği iddia edilmez; yalnız sonuç)
    const f = join(tmp("vlad-a-"), "a.json");
    writeFileSync(f, audit(2));
    const results = await Promise.all([
      runAsync(home, ["audit", "add", "--file", f, "--json"]),
      runAsync(home, ["card", "new", "--kind", "vlad_question", "--project", "alpha", "--title", "x", "--json"]),
      runAsync(home, ["quota", "set", "--until", new Date(Date.now() + 3_600_000).toISOString(), "--reason", "r", "--json"]),
      runAsync(home, ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--json"]),
    ]);
    for (const r of results) {
      expect(r.code, r.err).toBe(1);
      expect(JSON.parse(r.err).error).toMatch(/kb meşgul/);
    }
    expect(kbFiles(home, "audit")).toEqual([]);
    expect(kbFiles(home, "cards")).toEqual([]);
    rmSync(lockFile());
  }, 90_000);

  it("lock is released after every writing command (no leftover lock file)", () => {
    ok(home, ["card", "new", "--kind", "vlad_question", "--project", "alpha", "--title", "x"]);
    expect(existsSync(lockFile())).toBe(false);
    ok(home, ["quota", "set", "--until", new Date(Date.now() + 3_600_000).toISOString(), "--reason", "r"]);
    expect(existsSync(lockFile())).toBe(false);
    run(home, ["card", "new", "--kind", "bogus", "--project", "alpha", "--title", "x", "--json"]);
    expect(existsSync(lockFile())).toBe(false); // hata yolunda da bırakılır
  });
});
