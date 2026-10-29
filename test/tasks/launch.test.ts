import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { writeProject } from "../../src/projects/store.js";
import { addFinding } from "../../src/findings/store.js";
import { buildPrompt, cleanupTask, integrationWorktrees, launchTask, statusSummary } from "../../src/tasks/launch.js";
import { createTask, getTask, listTasks, saveTask, setState } from "../../src/tasks/index.js";
import { worktreePath } from "../../src/git/git.js";
import { trustKey } from "../../src/tasks/trust.js";
import { assertInside, makeHome, makeJunction, rmTemp } from "../helpers.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}

let repo: string;
let cfg: VladConfig;

let home: string;
afterEach(() => { rmTemp(dirname(repo)); rmTemp(home); });
beforeEach(() => {
  home = makeHome();
  const base = mkdtempSync(join(tmpdir(), "vlad-launch-"));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  cfg = defaultConfig();
  cfg.worktreeDir = join(base, "wt");
  writeProject("alpha", `---
slug: alpha
name: Alpha
path: ${JSON.stringify(repo)}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`);
});

function fakeLauncher(ok = true): Launcher & { reqs: LaunchRequest[] } {
  const reqs: LaunchRequest[] = [];
  return { reqs, async launch(r) { reqs.push(r); return ok ? { ok: true, method: "fake" } : { ok: false, method: "fake", detail: "boom" }; } };
}
const mk = (kind: "dev" | "research" = "dev") => createTask({ project: "alpha", title: "İlk görev", kind, body: "## Tanım\nx\n" });

describe("launchTask", () => {
  it("reads autonomy from config at launch: stale frontmatter is refreshed and the prompt block follows config", async () => {
    const t = mk();
    expect(t.data.autonomy).toBe("commit");
    cfg.projects.alpha = { autonomy: "pr" };
    const l = fakeLauncher();
    const r = await launchTask(t.data.id, { launcher: l, cfg });
    expect(r.data.autonomy).toBe("pr");
    expect(getTask(t.data.id).data.autonomy).toBe("pr");
    expect(l.reqs[0].prompt).toContain("Yetki seviyen: `pr`");
    expect(l.reqs[0].prompt).toContain("Yetki (autonomy pr)");
  });
  it("creates worktree, runs launcher and sets running", async () => {
    const t = mk();
    const l = fakeLauncher();
    const r = await launchTask(t.data.id, { launcher: l, cfg });
    const wt = worktreePath(cfg, repo, t.data.id);
    expect(r.data.state).toBe("running");
    expect(r.data.branch).toBe(`vlad/${t.data.id}`);
    expect(r.data.worktree).toBe(wt);
    expect(existsSync(wt)).toBe(true);
    expect(getTask(t.data.id).data.state).toBe("running");
    expect(l.reqs).toHaveLength(1);
    expect(l.reqs[0].cwd).toBe(wt);
    expect(l.reqs[0].env.VLAD_TASK_ID).toBe(t.data.id);
    expect(l.reqs[0].env.VLAD_HOME).toBe(process.env.VLAD_HOME);
    expect(l.reqs[0].prompt).toContain(t.file);
    expect(l.reqs[0].prompt).toContain("commit");
    expect(l.reqs[0].title).toBe(`VLAD ${t.data.id} — İlk görev`);
  });

  it("launcher failure keeps queued, records error and removes worktree", async () => {
    const t = mk();
    await expect(launchTask(t.data.id, { launcher: fakeLauncher(false), cfg })).rejects.toThrow(/boom/);
    const after = getTask(t.data.id);
    expect(after.data.state).toBe("queued");
    expect(after.data.error).toContain("boom");
    expect(existsSync(worktreePath(cfg, repo, t.data.id))).toBe(false);
  });

  it("can be retried after a launcher failure", async () => {
    const t = mk();
    await expect(launchTask(t.data.id, { launcher: fakeLauncher(false), cfg })).rejects.toThrow();
    const r = await launchTask(t.data.id, { launcher: fakeLauncher(), cfg });
    expect(r.data.state).toBe("running");
    expect(r.data.error).toBeNull();
  });

  it("existing worktree dir: error, state unchanged, dir untouched", async () => {
    const t = mk();
    const wt = worktreePath(cfg, repo, t.data.id);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "keep.txt"), "mine");
    const l = fakeLauncher();
    await expect(launchTask(t.data.id, { launcher: l, cfg })).rejects.toThrow(/zaten var/);
    const after = getTask(t.data.id);
    expect(after.data.state).toBe("queued");
    expect(after.data.error).toMatch(/zaten var/);
    expect(readdirSync(wt)).toEqual(["keep.txt"]);
    expect(readFileSync(join(wt, "keep.txt"), "utf8")).toBe("mine");
    expect(l.reqs).toHaveLength(0);
  });

  it("rollback uses branch -d: an unmerged branch survives and the failure is appended to the error", async () => {
    const t = mk();
    const wt = worktreePath(cfg, repo, t.data.id);
    const launcher: Launcher = {
      async launch() {
        writeFileSync(join(wt, "w.txt"), "work");
        git(wt, "add", ".");
        git(wt, "commit", "-m", "work");
        return { ok: false, method: "fake", detail: "boom" };
      },
    };
    await expect(launchTask(t.data.id, { launcher, cfg })).rejects.toThrow(/boom.*temizlik başarısız.*branch silinemedi/s);
    expect(getTask(t.data.id).data.error).toMatch(/boom.*branch silinemedi: vlad\//s);
    expect(git(repo, "branch", "--list", `vlad/${t.data.id}`)).toContain(`vlad/${t.data.id}`);
  });

  it("setState failure after a successful launch is recorded and rethrown", async () => {
    const t = mk();
    const launcher: Launcher = {
      async launch() {
        setState(t.data.id, "cancelled"); // makes queued->running invalid
        return { ok: true, method: "fake" };
      },
    };
    const wt = worktreePath(cfg, repo, t.data.id);
    await expect(launchTask(t.data.id, { launcher, cfg })).rejects.toThrow(/terminal açıldı ama durum güncellenemedi/);
    const err = getTask(t.data.id).data.error!;
    expect(err).toContain("terminal açıldı ama durum güncellenemedi");
    expect(err).toContain(`worktree: ${wt}`);
  });

  const writeRole = (slug: string) => {
    mkdirSync(join(process.env.VLAD_HOME!, "roles"), { recursive: true });
    const file = join(process.env.VLAD_HOME!, "roles", `${slug}.md`);
    writeFileSync(file, `---\nslug: ${slug}\ntitle: "Senior Tester'ın Rolü"\nkind: executor\nsummary: s\n---\n`);
    return file;
  };

  it("prompt names the role and its file", async () => {
    const file = writeRole("tester");
    const t = createTask({ project: "alpha", title: "x", kind: "dev", body: "", role: "tester" });
    const l = fakeLauncher();
    await launchTask(t.data.id, { launcher: l, cfg });
    expect(l.reqs[0].prompt).toContain(`Rolün: Senior Tester'ın Rolü. Göreve başlamadan önce \`${file}\` dosyasını oku`);
    expect(buildPrompt("f.md", "commit")).not.toContain("Rolün");
  });

  it("launch passes the role's model to the launcher; no model without one or without a role", async () => {
    const file = writeRole("tester");
    writeFileSync(file, readFileSync(file, "utf8").replace("summary: s\n", "summary: s\nmodel: sonnet\n"));
    const l = fakeLauncher();
    const a = createTask({ project: "alpha", title: "x", kind: "dev", body: "", role: "tester" });
    await launchTask(a.data.id, { launcher: l, cfg });
    writeRole("tester");
    const b = createTask({ project: "alpha", title: "x", kind: "dev", body: "", role: "tester" });
    await launchTask(b.data.id, { launcher: l, cfg });
    await launchTask(mk().data.id, { launcher: l, cfg });
    expect(l.reqs.map((r) => r.model)).toEqual(["sonnet", undefined, undefined]);
  });

  it("task model overrides the role's model; without a task model the role's model applies", async () => {
    const file = writeRole("tester");
    writeFileSync(file, readFileSync(file, "utf8").replace("summary: s\n", "summary: s\nmodel: sonnet\n"));
    const l = fakeLauncher();
    const a = createTask({ project: "alpha", title: "x", kind: "dev", body: "", role: "tester", model: "haiku" });
    await launchTask(a.data.id, { launcher: l, cfg });
    const b = createTask({ project: "alpha", title: "x", kind: "dev", body: "", model: "opus", modelReason: "kritik" });
    await launchTask(b.data.id, { launcher: l, cfg });
    expect(l.reqs.map((r) => r.model)).toEqual(["haiku", "opus"]);
  });

  it("prompt lists the role's skills, and has no skill sentence for an empty list", () => {
    const r = { title: "T", file: "r.md" };
    expect(buildPrompt("f.md", "commit", { ...r, skills: ["a:b", "c"] }))
      .toContain("İşe başlamadan şu skill'leri yükle: `a:b`, `c`. Yüklenemeyen olursa kapanış raporunda belirt.");
    expect(buildPrompt("f.md", "commit", { ...r, skills: [] })).not.toContain("skill'leri yükle");
  });

  it("a vendored skill (ponytail) is read from its file, not loaded by name (F-vlad-065)", () => {
    const home = join(tmpdir(), "H");
    const file = join(home, "roles", "developer.md");
    const p = buildPrompt("f.md", "commit", { title: "T", file, skills: ["a:b", "ponytail"] });
    expect(p).toContain("İşe başlamadan şu skill'leri yükle: `a:b`. Yüklenemeyen olursa kapanış raporunda belirt.");
    expect(p).toContain(`\`ponytail\` skill'i yüklü değildir; \`${join(home, "vendor", "skills", "ponytail", "SKILL.md")}\` dosyasını oku ve uygula.`);
    const only = buildPrompt("f.md", "commit", { title: "T", file, skills: ["ponytail"] });
    expect(only).not.toContain("skill'leri yükle");
    expect(only).toContain("dosyasını oku ve uygula");
  });

  it("launch with a deleted role file keeps queued, records error, opens no worktree", async () => {
    const file = writeRole("tester");
    const t = createTask({ project: "alpha", title: "x", kind: "dev", body: "", role: "tester" });
    rmSync(file);
    const l = fakeLauncher();
    await expect(launchTask(t.data.id, { launcher: l, cfg })).rejects.toThrow(/rol bulunamadı: tester/);
    expect(getTask(t.data.id).data).toMatchObject({ state: "queued", error: expect.stringMatching(/rol bulunamadı/) });
    expect(existsSync(worktreePath(cfg, repo, t.data.id))).toBe(false);
    expect(l.reqs).toHaveLength(0);
  });

  it("launch rechecks that the role still fits the task kind", async () => {
    const file = writeRole("tester");
    const t = createTask({ project: "alpha", title: "x", kind: "dev", body: "", role: "tester" });
    writeFileSync(file, readFileSync(file, "utf8").replace("kind: executor", "kind: advisory"));
    await expect(launchTask(t.data.id, { launcher: fakeLauncher(), cfg })).rejects.toThrow(/dev görevinde kullanılamaz/);
    expect(existsSync(worktreePath(cfg, repo, t.data.id))).toBe(false);
  });

  it("rejects non-queued and non-dev tasks", async () => {
    const t = mk();
    await launchTask(t.data.id, { launcher: fakeLauncher(), cfg });
    await expect(launchTask(t.data.id, { launcher: fakeLauncher(), cfg })).rejects.toThrow(/queued/);
    const r = mk("research");
    await expect(launchTask(r.data.id, { launcher: fakeLauncher(), cfg })).rejects.toThrow(/dev/);
  });
});

describe("pipeline launch", () => {
  const pipe = () => createTask({ project: "alpha", title: "çatı", kind: "pipeline", body: "" });
  const child = (parent: string, dependsOn: string[] = []) =>
    createTask({ project: "alpha", title: "faz", kind: "dev", body: "", parent, dependsOn, phase: "uygulama" });

  it("first phase launch creates the integration branch and worktree and runs the pipeline", async () => {
    const p = pipe();
    const c = child(p.data.id);
    await launchTask(c.data.id, { launcher: fakeLauncher(), cfg });
    const pd = getTask(p.data.id).data;
    expect(pd).toMatchObject({ state: "running", branch: `vlad/${p.data.id}`, worktree: worktreePath(cfg, repo, p.data.id) });
    expect(existsSync(pd.worktree!)).toBe(true);
    expect(git(pd.worktree!, "branch", "--show-current").trim()).toBe(`vlad/${p.data.id}`);
  });

  it("a child branches from the integration branch", async () => {
    const p = pipe();
    const a = child(p.data.id);
    const b = child(p.data.id);
    await launchTask(a.data.id, { launcher: fakeLauncher(), cfg });
    const iwt = getTask(p.data.id).data.worktree!;
    writeFileSync(join(iwt, "merged.txt"), "x");
    git(iwt, "add", ".");
    git(iwt, "commit", "-m", "entegrasyon");
    await launchTask(b.data.id, { launcher: fakeLauncher(), cfg });
    expect(existsSync(join(getTask(b.data.id).data.worktree!, "merged.txt"))).toBe(true);
    expect(existsSync(join(getTask(a.data.id).data.worktree!, "merged.txt"))).toBe(false);
  });

  it("an integration worktree removed by hand is re-attached from the existing branch", async () => {
    const p = pipe();
    const a = child(p.data.id);
    const b = child(p.data.id);
    await launchTask(a.data.id, { launcher: fakeLauncher(), cfg });
    const iwt = getTask(p.data.id).data.worktree!;
    git(repo, "worktree", "remove", "--force", iwt);
    await launchTask(b.data.id, { launcher: fakeLauncher(), cfg });
    expect(existsSync(iwt)).toBe(true);
    expect(git(iwt, "branch", "--show-current").trim()).toBe(`vlad/${p.data.id}`);
  });

  it("a launcher failure rolls back only the child", async () => {
    const p = pipe();
    const a = child(p.data.id);
    await expect(launchTask(a.data.id, { launcher: fakeLauncher(false), cfg })).rejects.toThrow(/boom/);
    const iwt = getTask(p.data.id).data.worktree!;
    expect(existsSync(iwt)).toBe(true);
    expect(git(repo, "branch", "--list", `vlad/${p.data.id}`)).toContain(`vlad/${p.data.id}`);
    expect(existsSync(worktreePath(cfg, repo, a.data.id))).toBe(false);
  });

  it("after a launcher failure on a moved integration branch, the phase can be retried", async () => {
    const p = pipe();
    const a = child(p.data.id);
    const b = child(p.data.id);
    await launchTask(a.data.id, { launcher: fakeLauncher(), cfg });
    const iwt = getTask(p.data.id).data.worktree!;
    writeFileSync(join(iwt, "m.txt"), "x");
    git(iwt, "add", ".");
    git(iwt, "commit", "-m", "entegrasyon");
    await expect(launchTask(b.data.id, { launcher: fakeLauncher(false), cfg })).rejects.toThrow(/boom/);
    expect(getTask(b.data.id).data.error).not.toMatch(/branch silinemedi/);
    const r = await launchTask(b.data.id, { launcher: fakeLauncher(), cfg });
    expect(r.data.state).toBe("running");
  });

  it("a failed first launch leaves the pipeline queued", async () => {
    const p = pipe();
    const a = child(p.data.id);
    await expect(launchTask(a.data.id, { launcher: fakeLauncher(false), cfg })).rejects.toThrow();
    expect(getTask(p.data.id).data.state).toBe("queued");
  });

  it("an unregistered folder at the integration worktree path is a clear error", async () => {
    const p = pipe();
    const a = child(p.data.id);
    const b = child(p.data.id);
    await launchTask(a.data.id, { launcher: fakeLauncher(), cfg });
    const iwt = getTask(p.data.id).data.worktree!;
    git(repo, "worktree", "remove", "--force", iwt);
    mkdirSync(iwt);
    await expect(launchTask(b.data.id, { launcher: fakeLauncher(), cfg })).rejects.toThrow(/git worktree'si değil/);
  });

  it("a phase under a closed pipeline cannot be launched", async () => {
    const p = pipe();
    const a = child(p.data.id);
    setState(p.data.id, "cancelled");
    await expect(launchTask(a.data.id, { launcher: fakeLauncher(), cfg })).rejects.toThrow(/çatı görev .* cancelled/);
    expect(existsSync(worktreePath(cfg, repo, p.data.id))).toBe(false);
  });

  it("a pipeline task itself cannot be launched", async () => {
    const p = pipe();
    await expect(launchTask(p.data.id, { launcher: fakeLauncher(), cfg })).rejects.toThrow(/yalnızca dev/);
  });

  it("cleanup removes the integration worktree of a done pipeline and keeps the branch", async () => {
    const p = pipe();
    const a = child(p.data.id);
    await launchTask(a.data.id, { launcher: fakeLauncher(), cfg });
    const iwt = getTask(p.data.id).data.worktree!;
    setState(p.data.id, "awaiting_approval");
    setState(p.data.id, "done");
    cleanupTask(p.data.id, { closeWorker: () => {} });
    expect(existsSync(iwt)).toBe(false);
    expect(git(repo, "branch", "--list", `vlad/${p.data.id}`)).toContain(`vlad/${p.data.id}`);
  });
});

describe("cross-project pipeline launch (F-vlad-044)", () => {
  let beta: string;
  let origin: string;
  beforeEach(() => {
    const base = join(repo, "..");
    beta = join(base, "beta");
    origin = join(base, "beta-origin.git");
    mkdirSync(beta);
    git(beta, "init", "-b", "main");
    writeFileSync(join(beta, "b.txt"), "1");
    git(beta, "add", ".");
    git(beta, "commit", "-m", "first");
    git(base, "init", "--bare", "-b", "main", origin);
    git(beta, "remote", "add", "origin", origin);
    git(beta, "push", "origin", "main");
    writeProject("beta", `---
slug: beta
name: Beta
path: ${JSON.stringify(beta)}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`);
  });
  const pipe = () => createTask({ project: "alpha", title: "çatı", kind: "pipeline", body: "" });
  const betaPhase = (parent: string) =>
    createTask({ project: "beta", title: "faz", kind: "dev", body: "", parent, phase: "uygulama" });
  /** the integration branch exists only on beta's origin, with one commit of its own */
  const remoteOnlyIntegration = (parentId: string) => {
    const b = `vlad/${parentId}`;
    git(beta, "switch", "-c", b);
    writeFileSync(join(beta, "remote.txt"), "r");
    git(beta, "add", ".");
    git(beta, "commit", "-m", "remote entegrasyon");
    git(beta, "push", "origin", b);
    git(beta, "switch", "main");
    git(beta, "branch", "-D", b);
  };

  it("phase branch is cut from the integration branch in the phase's repo; the pipeline's repo stays clean", async () => {
    const p = pipe();
    remoteOnlyIntegration(p.data.id);
    const c = betaPhase(p.data.id);
    const r = await launchTask(c.data.id, { launcher: fakeLauncher(), cfg });
    const wt = r.data.worktree!;
    expect(wt).toBe(worktreePath(cfg, beta, c.data.id));
    expect(git(wt, "branch", "--show-current").trim()).toBe(`vlad/${c.data.id}`);
    expect(existsSync(join(wt, "remote.txt"))).toBe(true);
    // integration branch is a tracking local branch in beta
    expect(git(beta, "rev-parse", "--abbrev-ref", `vlad/${p.data.id}@{upstream}`).trim()).toBe(`origin/vlad/${p.data.id}`);
    // nothing in alpha, and the pipeline record keeps alpha-only fields untouched
    expect(git(repo, "branch", "--list", `vlad/${p.data.id}`).trim()).toBe("");
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("vlad/");
    const pd = getTask(p.data.id).data;
    expect(pd.state).toBe("running");
    expect(pd.branch).toBeNull();
    expect(pd.worktree).toBeNull();
  });

  it("without a remote copy the integration branch is created from the phase repo's default branch", async () => {
    const p = pipe();
    const c = betaPhase(p.data.id);
    await launchTask(c.data.id, { launcher: fakeLauncher(), cfg });
    expect(git(beta, "rev-parse", `vlad/${p.data.id}`).trim()).toBe(git(beta, "rev-parse", "main").trim());
    expect(git(repo, "branch", "--list", `vlad/${p.data.id}`).trim()).toBe("");
  });

  it("a worktree that is not on the expected phase branch fails the launch, queued, integration branch kept", async () => {
    const p = pipe();
    remoteOnlyIntegration(p.data.id);
    const c = betaPhase(p.data.id);
    const launcher = fakeLauncher();
    await expect(launchTask(c.data.id, { launcher, cfg, branchOf: () => "vlad/baska" })).rejects.toThrow(/beklenen faz dalı/);
    expect(launcher.reqs).toHaveLength(0);
    expect(getTask(c.data.id).data.state).toBe("queued");
    expect(getTask(c.data.id).data.error).toMatch(/beklenen faz dalı/);
    expect(existsSync(worktreePath(cfg, beta, c.data.id))).toBe(false);
    expect(git(beta, "branch", "--list", `vlad/${p.data.id}`)).toContain(`vlad/${p.data.id}`);
  });

  it("a same-project phase still records the integration branch on the pipeline", async () => {
    const p = pipe();
    const a = createTask({ project: "alpha", title: "faz", kind: "dev", body: "", parent: p.data.id, phase: "uygulama" });
    await launchTask(a.data.id, { launcher: fakeLauncher(), cfg });
    expect(getTask(p.data.id).data).toMatchObject({ branch: `vlad/${p.data.id}`, worktree: worktreePath(cfg, repo, p.data.id) });
  });

  it("F-vlad-063: integrationWorktrees derives the integration worktree per phase project", async () => {
    cfg.worktreeDir = "{repo}-wt"; // per-repo dirs, as in the default config
    const p = pipe();
    await launchTask(betaPhase(p.data.id).data.id, { launcher: fakeLauncher(), cfg });
    await launchTask(createTask({ project: "alpha", title: "a", kind: "dev", body: "", parent: p.data.id, phase: "plan" }).data.id, { launcher: fakeLauncher(), cfg });
    const w = integrationWorktrees(p.data.id, cfg);
    expect(w.map((x) => x.project).sort()).toEqual(["alpha", "beta"]);
    expect(w.find((x) => x.project === "beta")).toMatchObject({
      repo: beta, branch: `vlad/${p.data.id}`, worktree: worktreePath(cfg, beta, p.data.id),
    });
    expect(w.find((x) => x.project === "alpha")!.worktree).toBe(worktreePath(cfg, repo, p.data.id));
  });

  it("F-vlad-094: integrationWorktrees gives the same answer from an already loaded task list (no per-pipeline re-read)", async () => {
    cfg.worktreeDir = "{repo}-wt";
    const p = pipe();
    await launchTask(betaPhase(p.data.id).data.id, { launcher: fakeLauncher(), cfg });
    const all = listTasks();
    expect(integrationWorktrees(p.data.id, cfg, all)).toEqual(integrationWorktrees(p.data.id, cfg));
  });

  it("F-vlad-063: a phase project whose card is gone is skipped; cleanup still removes the pipeline's own worktree", async () => {
    cfg.worktreeDir = "{repo}-wt";
    const p = pipe();
    await launchTask(createTask({ project: "alpha", title: "a", kind: "dev", body: "", parent: p.data.id, phase: "plan" }).data.id, { launcher: fakeLauncher(), cfg });
    createTask({ project: "beta", title: "faz", kind: "dev", body: "", parent: p.data.id, phase: "uygulama" });
    rmSync(join(process.env.VLAD_HOME!, "kb", "projects", "beta.md"));
    expect(integrationWorktrees(p.data.id, cfg).map((x) => x.project)).toEqual(["alpha"]);
    const awt = getTask(p.data.id).data.worktree!;
    setState(p.data.id, "awaiting_approval");
    setState(p.data.id, "done");
    cleanupTask(p.data.id, { closeWorker: () => {}, cfg });
    expect(existsSync(awt)).toBe(false);
  });

  it("F-vlad-063: cleanup of a done pipeline removes the integration worktree in the phase's project too, keeps branches", async () => {
    cfg.worktreeDir = "{repo}-wt"; // per-repo dirs, as in the default config
    const p = pipe();
    await launchTask(betaPhase(p.data.id).data.id, { launcher: fakeLauncher(), cfg });
    await launchTask(createTask({ project: "alpha", title: "a", kind: "dev", body: "", parent: p.data.id, phase: "plan" }).data.id, { launcher: fakeLauncher(), cfg });
    const bwt = worktreePath(cfg, beta, p.data.id);
    const awt = getTask(p.data.id).data.worktree!;
    expect(existsSync(bwt)).toBe(true);
    setState(p.data.id, "awaiting_approval");
    setState(p.data.id, "done");
    cleanupTask(p.data.id, { closeWorker: () => {}, cfg });
    expect(existsSync(bwt)).toBe(false);
    expect(existsSync(awt)).toBe(false);
    expect(git(beta, "branch", "--list", `vlad/${p.data.id}`)).toContain(`vlad/${p.data.id}`);
  });
});

describe("worktree trust (~/.claude.json)", () => {
  const trusted = () => JSON.parse(readFileSync(process.env.VLAD_CLAUDE_JSON!, "utf8")).projects ?? {};
  beforeEach(() => {
    process.env.VLAD_CLAUDE_JSON = join(mkdtempSync(join(tmpdir(), "vlad-cj-")), "claude.json");
  });

  it("launch trusts the worktree before the launcher runs", async () => {
    const t = mk();
    let seen: unknown;
    const l: Launcher = { async launch(r) { seen = trusted()[trustKey(r.cwd)]; return { ok: true, method: "fake" }; } };
    await launchTask(t.data.id, { launcher: l, cfg });
    expect(seen).toMatchObject({ hasTrustDialogAccepted: true });
  });

  it("an unwritable claude.json only warns, the launch still succeeds", async () => {
    writeFileSync(process.env.VLAD_CLAUDE_JSON!, "{broken");
    const t = mk();
    const r = await launchTask(t.data.id, { launcher: fakeLauncher(), cfg });
    expect(r.data.state).toBe("running");
    expect(readFileSync(process.env.VLAD_CLAUDE_JSON!, "utf8")).toBe("{broken");
  });

  it("cleanup removes the trust record of the removed worktree", async () => {
    const t = mk();
    await launchTask(t.data.id, { launcher: fakeLauncher(), cfg });
    setState(t.data.id, "awaiting_approval");
    setState(t.data.id, "done");
    const wt = getTask(t.data.id).data.worktree!;
    expect(trusted()[trustKey(wt)]).toBeDefined();
    cleanupTask(t.data.id, { closeWorker: () => {} });
    expect(trusted()[trustKey(wt)]).toBeUndefined();
  });
});

describe("cleanupTask", () => {
  it("refuses a running task", async () => {
    const t = mk();
    await launchTask(t.data.id, { launcher: fakeLauncher(), cfg });
    expect(() => cleanupTask(t.data.id)).toThrow();
  });
  it("removes the worktree of a done task but keeps the branch", async () => {
    const t = mk();
    await launchTask(t.data.id, { launcher: fakeLauncher(), cfg });
    setState(t.data.id, "awaiting_approval");
    setState(t.data.id, "done");
    const wt = getTask(t.data.id).data.worktree!;
    cleanupTask(t.data.id);
    expect(existsSync(wt)).toBe(false);
    expect(getTask(t.data.id).data.worktree).toBeNull();
    expect(git(repo, "branch", "--list", `vlad/${t.data.id}`)).toContain(`vlad/${t.data.id}`);
  });

  async function doneTask(): Promise<{ id: string; wt: string }> {
    const t = mk();
    await launchTask(t.data.id, { launcher: fakeLauncher(), cfg });
    setState(t.data.id, "awaiting_approval");
    setState(t.data.id, "done");
    return { id: t.data.id, wt: getTask(t.data.id).data.worktree! };
  }

  it("removes a leftover folder that git no longer tracks as a worktree", async () => {
    const { id, wt } = await doneTask();
    // git unregistered the worktree but the folder stayed (e.g. an earlier remove failed half way)
    rmSync(join(repo, ".git", "worktrees", id), { recursive: true, force: true });
    cleanupTask(id);
    expect(existsSync(wt)).toBe(false);
    expect(getTask(id).data.worktree).toBeNull();
  });

  // a process whose cwd is the worktree locks the folder on Windows, like the worker's terminal
  async function holdFolder(wt: string) {
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: wt, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    const exited = new Promise((r) => holder.once("exit", r));
    return { kill: async () => { holder.kill(); await exited; } };
  }

  it("closes the worker window before removing the worktree", async () => {
    const { id } = await doneTask();
    const closed: string[] = [];
    cleanupTask(id, { closeWorker: (taskId) => { closed.push(taskId); } });
    expect(closed).toEqual([id]);
  });

  it.runIf(process.platform === "win32")("a worker window closed by cleanup no longer blocks removal", async () => {
    const { id, wt } = await doneTask();
    const holder = await holdFolder(wt);
    let killed: Promise<void> | undefined;
    try {
      // the default closeWorker returns after taskkill; the lock may linger briefly, so don't wait here
      cleanupTask(id, { closeWorker: () => { killed = holder.kill(); } });
      expect(existsSync(wt)).toBe(false);
      expect(getTask(id).data.worktree).toBeNull();
    } finally {
      await (killed ?? holder.kill());
    }
  });

  it.runIf(process.platform === "win32")(
    "folder locked by a window cleanup could not close: clear error, task keeps worktree, retry succeeds",
    async () => {
      const { id, wt } = await doneTask();
      const holder = await holdFolder(wt);
      try {
        expect(() => cleanupTask(id, { closeWorker: () => {} })).toThrow(/çalışan penceresi.*vlad task cleanup/s);
        expect(getTask(id).data.worktree).toBe(wt);
      } finally {
        await holder.kill();
      }
      cleanupTask(id, { closeWorker: () => {} });
      expect(existsSync(wt)).toBe(false);
      expect(getTask(id).data.worktree).toBeNull();
    },
  );
});

describe("statusSummary", () => {
  it("counts states, lists active, marks stale and counts inbox", async () => {
    const a = mk();
    const b = mk();
    mk();
    await launchTask(a.data.id, { launcher: fakeLauncher(), cfg });
    await launchTask(b.data.id, { launcher: fakeLauncher(), cfg });
    const future = new Date(Date.now() + 7 * 3600_000);
    const s = statusSummary(cfg, future);
    expect(s.newlyStalled.sort()).toEqual([a.data.id, b.data.id].sort());
    expect(s.counts.stalled).toBe(2);
    expect(s.counts.queued).toBe(1);
    expect(s.counts.running).toBe(0);
    expect(s.active.map((t) => t.data.id).sort()).toEqual([a.data.id, b.data.id].sort());
    expect(s.inbox).toBe(0);
  });
  it("counts open critical/high findings in openSevereFindings", () => {
    expect(statusSummary(cfg, new Date()).openSevereFindings).toBe(0);
    addFinding({ project: "alpha", severity: "yüksek", source: "T20261022-01", title: "x", state: "deferred" });
    addFinding({ project: "alpha", severity: "orta", source: "T20261022-01", title: "y" });
    expect(statusSummary(cfg, new Date()).openSevereFindings).toBe(1);
  });
  it("lists failed tasks and queued tasks with an error in `failed`", () => {
    const a = mk(); // failed
    const b = mk(); // queued with error
    const c = mk(); // plain queued
    setState(a.data.id, "running");
    setState(a.data.id, "failed");
    const tb = getTask(b.data.id);
    tb.data.error = "launcher başarısız";
    saveTask(tb);
    const s = statusSummary(cfg, new Date());
    expect(s.failed.map((t) => t.data.id).sort()).toEqual([a.data.id, b.data.id].sort());
    expect(s.failed.map((t) => t.data.id)).not.toContain(c.data.id);
  });
});

describe("F-vlad-083/ cleanup never follows a junction out of the worktree", () => {
  let root: string; // fixture root = dir holding repo, wt and the junction target
  let ext: string;
  beforeEach(() => {
    root = dirname(repo);
    ext = join(root, "ext-node-modules");
    mkdirSync(join(ext, "deep"), { recursive: true });
    writeFileSync(join(ext, "keep.txt"), "k");
    writeFileSync(join(ext, "deep", "keep2.txt"), "k2");
  });
  afterEach(() => {
    assertInside(root, ext);
    rmSync(ext, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  async function doneTaskWithLink(): Promise<{ id: string; wt: string }> {
    const t = mk();
    await launchTask(t.data.id, { launcher: fakeLauncher(), cfg });
    const wt = getTask(t.data.id).data.worktree!;
    makeJunction(join(wt, "node_modules"), ext, root);
    setState(t.data.id, "awaiting_approval");
    setState(t.data.id, "done");
    return { id: t.data.id, wt };
  }

  it("fails closed when the worktree dir itself is a link: nothing is deleted, the record stays", async () => {
    const { id, wt } = await doneTaskWithLink();
    rmSync(join(wt, "node_modules"), { recursive: true, force: true }); // detaches the link only
    rmSync(wt, { recursive: true, force: true });
    makeJunction(wt, ext, root); // e.g. a stray junction left where the worktree was
    expect(() => cleanupTask(id, { closeWorker: () => {} })).toThrow(/bağlantıları kaldırılamadı, silme yapılmadı/);
    expect(existsSync(join(ext, "keep.txt"))).toBe(true);
    expect(existsSync(join(ext, "deep", "keep2.txt"))).toBe(true);
    expect(getTask(id).data.worktree).toBe(wt);
  });

  it("removes the link but leaves the target's files (junction/symlink)", async () => {
    const { id, wt } = await doneTaskWithLink();
    cleanupTask(id, { closeWorker: () => {} });
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(ext, "keep.txt"))).toBe(true);
    expect(existsSync(join(ext, "deep", "keep2.txt"))).toBe(true);
  });
});

describe("deps/ launch enforcement", () => {
  it("refuses a phase whose dependency is not done, with no side effects, then launches once it is", async () => {
    const p = createTask({ project: "alpha", title: "çatı", kind: "pipeline", body: "" });
    const dep = createTask({ project: "alpha", title: "d", kind: "dev", body: "", parent: p.data.id });
    const x = createTask({ project: "alpha", title: "x", kind: "dev", body: "", parent: p.data.id, dependsOn: [dep.data.id] });
    const l = fakeLauncher();
    await expect(launchTask(x.data.id, { launcher: l, cfg })).rejects.toThrow(`bağımlılıklar tamamlanmadı: ${dep.data.id}`);
    expect(l.reqs).toHaveLength(0);
    expect(existsSync(worktreePath(cfg, repo, x.data.id))).toBe(false);
    expect(getTask(x.data.id).data.state).toBe("queued");
    setState(dep.data.id, "running"); setState(dep.data.id, "awaiting_approval"); setState(dep.data.id, "done");
    expect((await launchTask(x.data.id, { launcher: l, cfg })).data.state).toBe("running");
  });
});
