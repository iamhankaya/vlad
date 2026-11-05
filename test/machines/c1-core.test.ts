import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { branchExists, worktreePath } from "../../src/git/git.js";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { ensureIntegrationGit, launchCore } from "../../src/tasks/launch-core.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" });

let repo: string;
let cfg: VladConfig;
let home: string;
beforeEach(() => {
  home = makeHome();
  const base = mkdtempSync(join(tmpdir(), "vlad-c1core-"));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  cfg = defaultConfig();
  cfg.worktreeDir = join(base, "wt");
});
afterEach(() => { rmTemp(dirname(repo)); rmTemp(home); });

const fake = (ok = true): Launcher & { reqs: LaunchRequest[] } => {
  const reqs: LaunchRequest[] = [];
  return { reqs, async launch(r) { reqs.push(r); return ok ? { ok: true, method: "fake", detail: "d" } : { ok: false, method: "fake", detail: "boom" }; } };
};
const req = (over: Record<string, unknown> = {}) => ({
  taskId: "T20261101-90", repo, worktree: worktreePath(cfg, repo, "T20261101-90"), branch: "vlad/T20261101-90",
  prompt: "p", env: { VLAD_TASK_ID: "T20261101-90", VLAD_HOME: home }, title: "t", ...over,
});

describe("machines:C1 launchCore", () => {
  it("worktree + dal açar, launcher'ı çağırır, {branch, worktree, method} döner; görev dosyası gerekmez (kb'ye dokunmaz)", async () => {
    const l = fake();
    const r = await launchCore(req(), l);
    expect(r).toMatchObject({ branch: "vlad/T20261101-90", method: "fake" });
    expect(existsSync(r.worktree)).toBe(true);
    expect(l.reqs).toHaveLength(1);
    expect(l.reqs[0].cwd).toBe(r.worktree);
  });

  it("launcher başarısızsa worktree ve dal geri alınır, hata fırlar", async () => {
    const r = req();
    await expect(launchCore(r, fake(false))).rejects.toThrow(/launcher başarısız \(fake\): boom/);
    expect(existsSync(r.worktree)).toBe(false);
    expect(branchExists(repo, r.branch)).toBe(false);
  });

  it("worktree beklenen dalda değilse hata ve temizlik (launcher çağrılmaz)", async () => {
    const l = fake();
    const r = req({ branchOf: () => "baska" });
    await expect(launchCore(r, l)).rejects.toThrow(/beklenen faz dalında değil/);
    expect(l.reqs).toHaveLength(0);
    expect(branchExists(repo, r.branch)).toBe(false);
  });

  it("base verilirse dal ondan açılır", async () => {
    git(repo, "branch", "taban");
    git(repo, "checkout", "-q", "taban");
    writeFileSync(join(repo, "b.txt"), "2");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "taban");
    git(repo, "checkout", "-q", "main");
    const r = await launchCore(req({ base: "taban" }), fake());
    expect(existsSync(join(r.worktree, "b.txt"))).toBe(true);
  });
});

describe("machines:C1 ensureIntegrationGit", () => {
  it("entegrasyon dalı + worktree'yi açar; kb kaydı yazmaz; ikinci çağrı aynı sonucu verir", () => {
    const a = ensureIntegrationGit(repo, "T20261101-80", cfg, "main");
    expect(a.branch).toBe("vlad/T20261101-80");
    expect(existsSync(a.worktree)).toBe(true);
    expect(ensureIntegrationGit(repo, "T20261101-80", cfg, "main")).toEqual(a);
  });
});

// F-vlad-239: failed -> queued -> launch must not die on the worktree/branch the failed run left behind.
describe("launchCore: failed görevin bıraktığı worktree/dal ile yeniden launch (F-vlad-239)", () => {
  it("sahibi doğrulanmış (vlad/<id> dalında) worktree'ye bağlanır; commit'ler korunur, launcher çağrılır", async () => {
    const r = req();
    await launchCore({ ...r, adopt: true }, fake());
    writeFileSync(join(r.worktree, "w.txt"), "iş");
    git(r.worktree, "add", ".");
    git(r.worktree, "commit", "-m", "wip: önceki tur");
    const l = fake();
    const again = await launchCore({ ...r, adopt: true }, l);
    expect(again).toMatchObject({ branch: r.branch, worktree: r.worktree });
    expect(l.reqs).toHaveLength(1);
    expect(existsSync(join(r.worktree, "w.txt"))).toBe(true);
  });

  it("yeniden kullanılan worktree'de launcher başarısızsa önceki iş silinmez (dal ve worktree kalır)", async () => {
    const r = req();
    await launchCore({ ...r, adopt: true }, fake());
    writeFileSync(join(r.worktree, "w.txt"), "iş");
    git(r.worktree, "add", ".");
    git(r.worktree, "commit", "-m", "wip");
    await expect(launchCore({ ...r, adopt: true }, fake(false))).rejects.toThrow(/launcher başarısız/);
    expect(existsSync(r.worktree)).toBe(true);
    expect(branchExists(repo, r.branch)).toBe(true);
  });

  it("worktree gitti ama dal kaldıysa dala yeniden bağlanır", async () => {
    const r = req();
    await launchCore({ ...r, adopt: true }, fake());
    git(repo, "worktree", "remove", "--force", r.worktree);
    const again = await launchCore({ ...r, adopt: true }, fake());
    expect(existsSync(again.worktree)).toBe(true);
  });

  it("klasör var ama başka dalda ise (sahip doğrulanamadı) reddeder ve dokunmaz", async () => {
    const r = req();
    await launchCore({ ...r, adopt: true }, fake());
    const l = fake();
    await expect(launchCore({ ...r, adopt: true, branchOf: () => "baska" }, l)).rejects.toThrow(/zaten var/);
    expect(l.reqs).toHaveLength(0);
    expect(existsSync(r.worktree)).toBe(true);
    expect(branchExists(repo, r.branch)).toBe(true);
  });

  it("klasör git worktree'si değilse reddeder", async () => {
    const r = req();
    mkdirSync(r.worktree, { recursive: true });
    await expect(launchCore(r, fake())).rejects.toThrow(/zaten var/);
  });

  it("adopt olmadan (ilk launch) mevcut worktree/dal yabancı sayılır: zaten var", async () => {
    const r = req();
    await launchCore(r, fake());
    const l = fake();
    await expect(launchCore(r, l)).rejects.toThrow(/zaten var/);
    expect(l.reqs).toHaveLength(0);
  });

  it("reused sonucu işaretlenir; yeni açılışta işaret yok", async () => {
    const r = req();
    expect((await launchCore({ ...r, adopt: true }, fake())).reused).toBeUndefined();
    expect((await launchCore({ ...r, adopt: true }, fake())).reused).toBe(true);
  });

  // F-vlad-248
  it("kirli worktree'ye yeniden bağlanır: kaydedilmemiş dosya korunur, launcher çağrılır", async () => {
    const r = req();
    await launchCore({ ...r, adopt: true }, fake());
    writeFileSync(join(r.worktree, "kirli.txt"), "bitmemiş");
    const l = fake();
    expect((await launchCore({ ...r, adopt: true }, l)).reused).toBe(true);
    expect(readFileSync(join(r.worktree, "kirli.txt"), "utf8")).toBe("bitmemiş");
    expect(l.reqs).toHaveLength(1);
  });

  it("dal başka bir worktree'de checkout'luysa ham git hatası değil, yolu söyleyen açık hata", async () => {
    const r = req();
    await launchCore({ ...r, adopt: true }, fake());
    const other = join(dirname(r.worktree), "baska-yer");
    git(repo, "worktree", "move", r.worktree, other);
    const l = fake();
    await expect(launchCore({ ...r, adopt: true }, l)).rejects.toThrow(new RegExp(`başka worktree'de.*${other.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
    expect(l.reqs).toHaveLength(0);
  });

  it("base verilmiş ve dal ondan geride kalmışsa uyarır (yine bağlanır, iş silinmez)", async () => {
    const r = req({ base: "main" });
    await launchCore({ ...r, adopt: true }, fake());
    writeFileSync(join(repo, "b.txt"), "2"); git(repo, "add", "."); git(repo, "commit", "-m", "ilerledi");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await launchCore({ ...r, adopt: true }, fake())).reused).toBe(true);
      expect(err.mock.calls.flat().join("\n")).toMatch(/main.*geride/);
    } finally { err.mockRestore(); }
  });

  it("base ile güncel dalda uyarı yok", async () => {
    const r = req({ base: "main" });
    await launchCore({ ...r, adopt: true }, fake());
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await launchCore({ ...r, adopt: true }, fake());
      expect(err.mock.calls.flat().join("\n")).not.toMatch(/geride/);
    } finally { err.mockRestore(); }
  });
});
