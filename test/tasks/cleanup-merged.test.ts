import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, saveTask } from "../../src/tasks/index.js";
import { cleanupMerged, diskWarning } from "../../src/tasks/cleanup-merged.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });

let base: string, repo: string, wtRoot: string, cfg: VladConfig, home: string;
beforeEach(() => {
  home = makeHome();
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-cmerged-")));
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

const noWindow = { alive: () => false };
const opts = (o: Record<string, unknown> = {}) => ({ dryRun: false, probe: noWindow, closeWorker: () => {}, ...o });

/** Görev + worktree + dal; `commit` dalda ek commit atar, `merge` o dalı hedefe (main ya da verilen dal) alır. */
function mk(state: "done" | "cancelled" | "running", o: { commit?: boolean; merge?: boolean; parent?: string; kind?: "dev" | "pipeline"; into?: string; dirty?: boolean } = {}) {
  const t = createTask({ project: "alpha", title: "t", kind: o.kind ?? "dev", body: "## Tanım\nx\n", ...(o.parent ? { parent: o.parent } : {}) });
  const id = t.data.id;
  const wt = join(wtRoot, id);
  const from = o.parent ? `vlad/${o.parent}` : "main";
  git(repo, "worktree", "add", "-b", `vlad/${id}`, wt, from);
  if (o.commit) { writeFileSync(join(wt, `${id}.txt`), "x"); git(wt, "add", "."); git(wt, "commit", "-m", "work"); }
  if (o.merge) {
    const into = o.into ?? "main";
    if (into === "main") git(repo, "merge", "--no-ff", "-m", "m", `vlad/${id}`);
    else {
      const w = join(wtRoot, o.parent!);
      git(w, "merge", "--no-ff", "-m", "m", `vlad/${id}`);
    }
  }
  if (o.dirty) writeFileSync(join(wt, "scratch.txt"), "dirty");
  const r = getTask(id);
  r.data.state = state;
  r.data.worktree = wt;
  saveTask(r);
  return { id, wt };
}
const item = (r: { items: { id: string }[] }, id: string) => r.items.find((i) => i.id === id) as { id: string; action: string; reason?: string; removed?: boolean; bytes?: number };

describe("cleanupMerged (F-vlad-375)", () => {
  it("done + dalı ana dala girmiş → worktree kaldırılır, dal silinmez, kb'de worktree null", () => {
    const a = mk("done", { commit: true, merge: true });
    const r = cleanupMerged(cfg, opts());
    expect(item(r, a.id).action).toBe("remove");
    expect(existsSync(a.wt)).toBe(false);
    expect(git(repo, "branch", "--list", `vlad/${a.id}`)).toContain(`vlad/${a.id}`);
    expect(getTask(a.id).data.worktree).toBeNull();
    expect(r.removed).toBe(1);
  });

  it("dry-run: hiçbir şeye dokunmaz, adayı ve boyutu raporlar", () => {
    const a = mk("done", { commit: true, merge: true });
    const r = cleanupMerged(cfg, opts({ dryRun: true }));
    expect(r.dryRun).toBe(true);
    expect(item(r, a.id).action).toBe("remove");
    expect(item(r, a.id).removed).toBeUndefined();
    expect(r.candidateBytes).toBeGreaterThan(0);
    expect(existsSync(a.wt)).toBe(true);
    expect(getTask(a.id).data.worktree).toBe(a.wt);
  });

  it("merge edilmemiş (ek commit'li) done görev atlanır, nedeni yazılır", () => {
    const a = mk("done", { commit: true });
    const r = cleanupMerged(cfg, opts());
    expect(item(r, a.id).action).toBe("skip");
    expect(item(r, a.id).reason).toMatch(/merge/);
    expect(existsSync(a.wt)).toBe(true);
  });

  it("kirli (commit'lenmemiş değişiklik) worktree atlanır", () => {
    const a = mk("done", { commit: true, merge: true, dirty: true });
    const r = cleanupMerged(cfg, opts());
    expect(item(r, a.id).action).toBe("skip");
    expect(item(r, a.id).reason).toMatch(/kirli/);
    expect(existsSync(a.wt)).toBe(true);
  });

  it("yalnız .remember içeren untracked klasör kirli sayılmaz", () => {
    const a = mk("done", { commit: true, merge: true });
    mkdirSync(join(a.wt, ".remember", "logs"), { recursive: true });
    writeFileSync(join(a.wt, ".remember", "logs", "x.log"), "x");
    const r = cleanupMerged(cfg, opts());
    expect(item(r, a.id).action).toBe("remove");
  });

  it("çalışan penceresi açıksa (süreç görev ID'sini anıyor) atlanır; pencere kapatılmaz", () => {
    const a = mk("done", { commit: true, merge: true });
    let closed = 0;
    const r = cleanupMerged(cfg, opts({ probe: { alive: () => true }, closeWorker: () => { closed++; } }));
    expect(item(r, a.id).action).toBe("skip");
    expect(item(r, a.id).reason).toMatch(/pencere/);
    expect(closed).toBe(0);
    expect(existsSync(a.wt)).toBe(true);
  });

  it("süreç listesi okunamıyorsa (alive null) güvenli tarafta kalır: atlanır", () => {
    const a = mk("done", { commit: true, merge: true });
    const r = cleanupMerged(cfg, opts({ probe: { alive: () => null } }));
    expect(item(r, a.id).action).toBe("skip");
    expect(existsSync(a.wt)).toBe(true);
  });

  it("worktree başka dalda ya da ayrık HEAD'de ise (vlad dalı merge edilmiş olsa da) atlanır: commit'ler yalnız reflog'da kalmasın", () => {
    const a = mk("done", { commit: true, merge: true });
    git(a.wt, "checkout", "-q", "--detach");
    writeFileSync(join(a.wt, "kayip.txt"), "x"); git(a.wt, "add", "."); git(a.wt, "commit", "-q", "-m", "ayrik iş");
    const r = cleanupMerged(cfg, opts());
    expect(item(r, a.id).action).toBe("skip");
    expect(item(r, a.id).reason).toMatch(/dalında değil|ayrık/);
    expect(existsSync(a.wt)).toBe(true);
    const b = mk("done", { commit: true, merge: true });
    git(b.wt, "checkout", "-q", "-b", "baska");
    expect(item(cleanupMerged(cfg, opts({ dryRun: true })), b.id).action).toBe("skip");
  });

  it("kb'de başka işletim sisteminin yolu kayıtlıysa (Windows yolu, POSIX makine) atlanır, kayıt silinmez", () => {
    const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "## Tanım\nx\n" });
    const r0 = getTask(t.data.id); r0.data.state = "done"; r0.data.worktree = "C:\\dev\\alpha-wt\\" + t.data.id; saveTask(r0);
    const r = cleanupMerged(cfg, opts({ platform: "darwin" }));
    expect(item(r, t.data.id).action).toBe("skip");
    expect(item(r, t.data.id).reason).toMatch(/işletim sistemi/);
    expect(getTask(t.data.id).data.worktree).toBe("C:\\dev\\alpha-wt\\" + t.data.id);
  });

  it("çatının kayıtlı worktree'si hesaplanan yoldan farklıysa o da denetlenir (kirliyse dokunulmaz)", () => {
    const pipe = createTask({ project: "alpha", title: "p", kind: "pipeline", body: "## Tanım\nx\n" });
    const pid = pipe.data.id;
    const alt = join(base, "eski-wt", pid);
    git(repo, "worktree", "add", "-b", `vlad/${pid}`, alt, "main");
    writeFileSync(join(alt, "scratch.txt"), "dirty");
    const pr = getTask(pid); pr.data.state = "done"; pr.data.worktree = alt; saveTask(pr);
    const r = cleanupMerged(cfg, opts());
    expect(item(r, pid).action).toBe("skip");
    expect(item(r, pid).reason).toMatch(/kirli/);
    expect(existsSync(alt)).toBe(true);
  });

  it("taramadan sonra görev yeniden başlatılmışsa (running) silme anında yeniden doğrulanır ve atlanır", () => {
    const a = mk("done", { commit: true, merge: true });
    let calls = 0;
    const probe = { alive: () => { if (++calls === 1) { const t = getTask(a.id); t.data.state = "running"; saveTask(t); } return false; } };
    const r = cleanupMerged(cfg, opts({ probe }));
    expect(item(r, a.id).action).toBe("skip");
    expect(item(r, a.id).reason).toMatch(/taramadan sonra değişti/);
    expect(existsSync(a.wt)).toBe(true);
    expect(r.removed).toBe(0);
  });

  it("yargı zaman bütçesi dolarsa tarama yarıda kalır ve truncated işaretlenir", () => {
    mk("done", { commit: true, merge: true });
    mk("done", { commit: true, merge: true });
    const r = cleanupMerged(cfg, opts({ dryRun: true, judgeBudgetMs: 1, probe: { alive: () => { const t = Date.now(); while (Date.now() - t < 5); return false; } } }));
    expect(r.truncated).toBe(true);
  });

  it("running görev listeye girmez, worktree'sine dokunulmaz", () => {
    const a = mk("running", { commit: true, merge: true });
    const r = cleanupMerged(cfg, opts());
    expect(r.items.find((i) => i.id === a.id)).toBeUndefined();
    expect(existsSync(a.wt)).toBe(true);
  });

  it("cancelled + ek commit yok (dal tabanla aynı) → kaldırılır", () => {
    const a = mk("cancelled");
    const r = cleanupMerged(cfg, opts());
    expect(item(r, a.id).action).toBe("remove");
    expect(existsSync(a.wt)).toBe(false);
  });

  it("cancelled + merge edilmemiş commit → atlanır (iş kaybolmasın)", () => {
    const a = mk("cancelled", { commit: true });
    const r = cleanupMerged(cfg, opts());
    expect(item(r, a.id).action).toBe("skip");
    expect(existsSync(a.wt)).toBe(true);
  });

  it("--project süzgeci: başka projenin görevi listeye girmez", () => {
    const a = mk("done", { commit: true, merge: true });
    const r = cleanupMerged(cfg, opts({ project: "beta" }));
    expect(r.items).toEqual([]);
    expect(existsSync(a.wt)).toBe(true);
  });

  it("çatı: faz dalı entegrasyon dalına girmişse faz worktree'si kaldırılır; çatı entegrasyon worktree'si çatı ana dala girene dek kalır", () => {
    const pipe = createTask({ project: "alpha", title: "p", kind: "pipeline", body: "## Tanım\nx\n" });
    const pid = pipe.data.id;
    const iw = join(wtRoot, pid);
    git(repo, "worktree", "add", "-b", `vlad/${pid}`, iw, "main");
    const pr = getTask(pid); pr.data.worktree = iw; saveTask(pr); // çatı açıkken faz eklenir, sonra done olur
    const ph = mk("done", { commit: true, merge: true, parent: pid, into: "integration" });
    const pd = getTask(pid); pd.data.state = "done"; saveTask(pd);
    const r = cleanupMerged(cfg, opts());
    expect(item(r, ph.id).action).toBe("remove");
    expect(existsSync(ph.wt)).toBe(false);
    // çatı: entegrasyon dalında faz commit'i var, ana dalda yok → kalır
    expect(item(r, pid).action).toBe("skip");
    expect(existsSync(iw)).toBe(true);
    // çatı ana dala girince kaldırılır
    git(repo, "merge", "--no-ff", "-m", "final", `vlad/${pid}`);
    const r2 = cleanupMerged(cfg, opts());
    expect(item(r2, pid).action).toBe("remove");
    expect(existsSync(iw)).toBe(false);
  });

  it("çatısı done olmayan pipeline'ın entegrasyon worktree'si kaldırılmaz", () => {
    const pipe = createTask({ project: "alpha", title: "p", kind: "pipeline", body: "## Tanım\nx\n" });
    const iw = join(wtRoot, pipe.data.id);
    git(repo, "worktree", "add", "-b", `vlad/${pipe.data.id}`, iw, "main");
    const pr = getTask(pipe.data.id); pr.data.state = "running"; pr.data.worktree = iw; saveTask(pr);
    const r = cleanupMerged(cfg, opts());
    expect(r.items.find((i) => i.id === pipe.data.id)).toBeUndefined();
    expect(existsSync(iw)).toBe(true);
  });

  it("worktree klasörü zaten yoksa kb kaydı temizlenir, hata vermez", () => {
    const a = mk("done", { commit: true, merge: true });
    git(repo, "worktree", "remove", "--force", a.wt);
    const r = cleanupMerged(cfg, opts());
    expect(r.errors).toBe(0);
    expect(getTask(a.id).data.worktree).toBeNull();
  });

  it("bir görevin kaldırılması hata verirse diğerleri sürer (hata raporlanır)", () => {
    const a = mk("done", { commit: true, merge: true });
    const b = mk("done", { commit: true, merge: true });
    const r = cleanupMerged(cfg, opts({ cleanup: (id: string) => { if (id === a.id) throw new Error("kilitli"); } }));
    expect(r.errors).toBe(1);
    expect(item(r, a.id).removed).toBeUndefined();
    expect((item(r, a.id) as { error?: string }).error).toMatch(/kilitli/);
    expect(item(r, b.id).removed).toBe(true);
  });
});

describe("diskWarning (F-vlad-375)", () => {
  const GB = 1024 ** 3;
  it("boş alan eşiğin üstündeyse null", () => {
    expect(diskWarning(cfg, { freeBytes: () => 50 * GB })).toBeNull();
  });
  it("eşiğin altındaysa uyarı: boş GB, eşik ve temizlenebilir worktree sayısı/boyutu", () => {
    const a = mk("done", { commit: true, merge: true });
    mkdirSync(join(a.wt, ".remember"), { recursive: true }); // yalnız .remember kirli sayılmaz; boyuta girer
    writeFileSync(join(a.wt, ".remember", "big.bin"), Buffer.alloc(1024 * 64));
    const w = diskWarning(cfg, { freeBytes: () => 5 * GB, probe: noWindow });
    expect(w).not.toBeNull();
    expect(w!.freeGb).toBeCloseTo(5, 1);
    expect(w!.thresholdGb).toBe(20);
    expect(w!.cleanable.count).toBe(1);
    expect(w!.cleanable.bytes).toBeGreaterThan(0);
    expect(w!.text).toMatch(/5\.0 GB/);
    expect(w!.text).toMatch(/task cleanup --merged/);
  });
  it("eşik vlad.config.json'daki minFreeDiskGb ile ayarlanır", () => {
    expect(diskWarning({ ...cfg, minFreeDiskGb: 2 }, { freeBytes: () => 5 * GB })).toBeNull();
    expect(diskWarning({ ...cfg, minFreeDiskGb: 10 }, { freeBytes: () => 5 * GB })).not.toBeNull();
  });
  it("scan:false (SessionStart hook): git taraması yok, yalnız boş alan; dry-run önerisi yazılır", () => {
    mk("done", { commit: true, merge: true });
    const w = diskWarning(cfg, { freeBytes: () => 5 * GB, scan: false });
    expect(w!.scanned).toBe(false);
    expect(w!.cleanable.count).toBe(0);
    expect(w!.text).toMatch(/task cleanup --merged --dry-run/);
  });
  it("boş alan okunamazsa (null) uyarı yok", () => {
    expect(diskWarning(cfg, { freeBytes: () => null })).toBeNull();
  });
});
