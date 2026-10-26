// Kabul testleri: T20261020-01 bulut (cloud) launcher — spec senaryoları 1-7, 11.
// Yalnızca arayüzlerden yazıldı: config `launcher: cloud`, kart `repo`/`local_only`,
// `vlad task launch --json` cloud çıktısı. Uygulama gelmeden kırmızı olması beklenir.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/kb/index.js";
import { loadConfig } from "../../src/kb/config.js";
import { launchTask } from "../../src/tasks/launch.js";
import { createTask } from "../../src/tasks/index.js";
import { writeProject } from "../../src/projects/store.js";
import { makeHome } from "../helpers.js";
import { CLOUD_ENV, NO_CLOUD_ENV, build, forceRunning, newTask, readTask, taskState, tmp, vlad, writeCard, writeRoles } from "./cloud-helpers.js";

let home: string;
beforeAll(build, 120000);
beforeEach(() => { home = makeHome(); });

const setLauncher = (launcher: string) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher, cloudKb: "inline" }));
const launch = (id: string, env: Record<string, string | undefined>) => vlad(home, ["task", "launch", id, "--json"], { env });
const onLinux = process.platform === "linux";

describe("senaryo 1: config launcher=cloud", { timeout: 30_000 }, () => {
  it("şema `cloud` değerini kabul eder", () => {
    setLauncher("cloud");
    expect(loadConfig(home).launcher).toBe("cloud");
  });
  it("bilinmeyen launcher değeri hâlâ reddedilir", () => {
    setLauncher("tmux");
    expect(() => loadConfig(home)).toThrow();
  });
  it("mevcut değerler (auto|wt|powershell) geçerli kalır", () => {
    for (const l of ["auto", "wt", "powershell"]) {
      setLauncher(l);
      expect(loadConfig(home).launcher).toBe(l);
    }
  });
});

describe("senaryo 2: Windows davranışı değişmez", { timeout: 30_000 }, () => {
  const realPlatform = process.platform;
  beforeEach(() => { Object.defineProperty(process, "platform", { value: "win32" }); });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
    vi.unstubAllEnvs();
  });

  it("auto + win32: bulut işaretleri olsa bile yerel worktree + terminal launcher kullanılır, bulut modu seçilmez", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const { execFileSync } = await import("node:child_process");
    const base = tmp("vlad-win-");
    const repo = join(base, "alpha");
    mkdirSync(repo);
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "pipe" });
    g("init", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "1");
    g("add", ".");
    g("commit", "-m", "first");
    writeProject("alpha", `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
    const cfg = defaultConfig();
    cfg.launcher = "auto";
    cfg.worktreeDir = join(base, "wt");
    const t = createTask({ project: "alpha", title: "W", kind: "dev", body: "## Tanım\nx\n" });
    const reqs: { cwd: string }[] = [];
    const r = await launchTask(t.data.id, { launcher: { async launch(req) { reqs.push(req); return { ok: true, method: "wt" }; } }, cfg });
    expect(r.data.state).toBe("running");
    expect(r.data.worktree).toBeTruthy();
    expect(existsSync(r.data.worktree!)).toBe(true);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].cwd).toBe(r.data.worktree);
  });
});

describe.runIf(onLinux)("senaryo 3-4: auto seçimi (Linux)", { timeout: 30_000 }, () => {
  beforeEach(() => { setLauncher("auto"); writeCard(home, "alpha", { repo: "iamhankaya/vlad" }); });

  it("senaryo 3: auto + Linux + bulut işaretleri → cloud modu", () => {
    const id = newTask(home);
    const r = launch(id, CLOUD_ENV);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ id, mode: "cloud", action: "create_session", state: "running" });
  });

  it("senaryo 4: auto + Linux + bulut yok → açık hata, görev queued", () => {
    const id = newTask(home);
    const r = launch(id, NO_CLOUD_ENV);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/bulut|cloud|launcher/i);
    expect(taskState(home, id)).toBe("queued");
    expect(readTask(home, id)).toMatch(/error: \S/);
  });
});

describe.runIf(onLinux)("senaryo 5: cloud launch --json", { timeout: 30_000 }, () => {
  beforeEach(() => { setLauncher("cloud"); writeRoles(home); writeCard(home, "alpha", { repo: "iamhankaya/vlad" }); });

  it("başlatma bilgisini döndürür, görevi running yapar, yerel worktree/terminal açmaz", () => {
    const id = newTask(home, ["--role", "tester"]);
    const r = launch(id, CLOUD_ENV);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({
      id, state: "running", mode: "cloud", action: "create_session",
      repo: "iamhankaya/vlad", source_url: "https://github.com/iamhankaya/vlad",
      outcome_branch: `vlad/${id}`, branch: `vlad/${id}`, worktree: null,
      integration: null, model: "sonnet", title: expect.stringContaining(`VLAD ${id}`),
    });
    expect(typeof j.source_revision).toBe("string");
    expect(j.source_revision).not.toMatch(/^vlad\//);
    expect(j.base_branch).toBe(j.source_revision);
    expect(j.tags).toEqual(expect.arrayContaining(["vlad", `vlad-task:${id}`, "vlad-project:alpha"]));
    expect(j.permission_mode).toBeTruthy();
    expect(Array.isArray(j.next)).toBe(true);
    expect(taskState(home, id)).toBe("running");
  });

  it("prompt görevi, rol dosyasını ve [VLAD:*] protokolünü satır içi taşır; kb yazma/merge/PR yasaktır", () => {
    const id = newTask(home, ["--role", "tester"]);
    const { prompt } = JSON.parse(launch(id, CLOUD_ENV).out);
    expect(prompt).toContain(id);
    expect(prompt).toContain("Bulut görev gövdesi");
    expect(prompt).toContain("RolGovdesiMarker");
    for (const m of ["[VLAD:LOG", "[VLAD:ASK", "[VLAD:REPORT", "[VLAD:END", "[VLAD:FAIL", "[VLAD:ANSWER"]) expect(prompt).toContain(m);
    expect(prompt).toContain(`vlad/${id}`);
    expect(prompt).toMatch(/kb\//);
  });

  it("autonomy=plan: prompt push'u yasaklar (yetki seviyesi plan olarak geçer)", () => {
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "cloud", projects: { alpha: { autonomy: "plan" } } }));
    const id = newTask(home);
    const r = launch(id, CLOUD_ENV);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).prompt).toMatch(/plan/);
  });

  it("yerel worktree dizini oluşturulmaz", () => {
    const wt = join(tmp("vlad-nowt-"), "wt");
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "cloud", worktreeDir: wt }));
    const id = newTask(home);
    expect(launch(id, CLOUD_ENV).code).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  it("research görevi için cloud launch hata verir, görev queued kalır", () => {
    const r0 = vlad(home, ["task", "new", "--project", "alpha", "--title", "R", "--kind", "research", "--json"]);
    const id = JSON.parse(r0.out).id as string;
    const r = launch(id, CLOUD_ENV);
    expect(r.code).toBe(1);
    expect(taskState(home, id)).toBe("queued");
  });
});

describe.runIf(onLinux)("senaryo 6: pipeline fazı", { timeout: 30_000 }, () => {
  beforeEach(() => { setLauncher("cloud"); writeCard(home, "alpha", { repo: "iamhankaya/vlad" }); });

  // `git ls-remote https://github.com/iamhankaya/vlad.git` is redirected to a local bare repo, so the
  // remote state is deterministic (no network, no dependency on branches of the real repo).
  const fakeRemote = (withBranch?: string) => {
    const bare = join(tmp(), "remote.git");
    const work = join(tmp(), "work");
    const git = (cwd: string, ...a: string[]) => execFileSync("git", a, {
      cwd, stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
    });
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare", "-q");
    mkdirSync(work, { recursive: true });
    git(work, "init", "-q");
    git(work, "commit", "--allow-empty", "-q", "-m", "x");
    git(work, "push", "-q", bare, `HEAD:refs/heads/${withBranch ?? "master"}`);
    return {
      ...CLOUD_ENV,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/iamhankaya/vlad.git",
    };
  };
  const pipelinePhase = () => {
    const parent = JSON.parse(vlad(home, ["task", "new", "--project", "alpha", "--title", "P", "--kind", "pipeline", "--json"]).out).id as string;
    return { parent, phase: newTask(home, ["--parent", parent, "--phase", "kabul"]) };
  };

  it("kaynak entegrasyon dalı vlad/<çatı-id>; remote'ta yoksa needs_remote_create: true", () => {
    const { parent, phase } = pipelinePhase();
    const r = launch(phase, fakeRemote());
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.source_revision).toBe(`vlad/${parent}`);
    expect(j.base_branch).toBe(`vlad/${parent}`);
    expect(j.outcome_branch).toBe(`vlad/${phase}`);
    expect(j.integration).toMatchObject({ branch: `vlad/${parent}`, needs_remote_create: true });
    expect(typeof j.integration.from).toBe("string");
    expect(j.worktree).toBeNull();
  });

  it("remote'ta varsa needs_remote_create: false", () => {
    const parent = JSON.parse(vlad(home, ["task", "new", "--project", "alpha", "--title", "P", "--kind", "pipeline", "--json"]).out).id as string;
    const phase = newTask(home, ["--parent", parent, "--phase", "kabul"]);
    const r = launch(phase, fakeRemote(`vlad/${parent}`));
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).integration).toMatchObject({ branch: `vlad/${parent}`, needs_remote_create: false });
  });

  it("prompt bağımlı fazın kapanış raporunu satır içi taşır", () => {
    const parent = JSON.parse(vlad(home, ["task", "new", "--project", "alpha", "--title", "P", "--kind", "pipeline", "--json"]).out).id as string;
    const dep = newTask(home, ["--parent", parent, "--phase", "spec"]);
    forceRunning(home, dep);
    writeFileSync(join(home, "rapor.md"), "### Amaç\nBagimliRaporMarker\n");
    expect(vlad(home, ["task", "report", dep, "--file", join(home, "rapor.md"), "--json"]).code).toBe(0);
    expect(vlad(home, ["task", "set", dep, "done", "--json"]).code).toBe(0);
    const phase = newTask(home, ["--parent", parent, "--phase", "kabul", "--depends-on", dep]);
    const r = launch(phase, CLOUD_ENV);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).prompt).toContain("BagimliRaporMarker");
  });

  it("çatı görev kapalıysa faz başlatılamaz (yerel davranışla aynı)", () => {
    const parent = JSON.parse(vlad(home, ["task", "new", "--project", "alpha", "--title", "P", "--kind", "pipeline", "--json"]).out).id as string;
    const phase = newTask(home, ["--parent", parent, "--phase", "kabul"]);
    expect(vlad(home, ["task", "set", parent, "cancelled", "--json"]).code).toBe(0);
    expect(launch(phase, CLOUD_ENV).code).toBe(1);
    expect(taskState(home, phase)).toBe("queued");
  });
});

describe.runIf(onLinux)("senaryo 7: repo yok / local_only", { timeout: 30_000 }, () => {
  beforeEach(() => setLauncher("cloud"));

  it("kartta repo yoksa açık hata; görev queued, error dolu; C:\\dev yolu bulutta kullanılmaz", () => {
    writeCard(home, "alpha");
    const id = newTask(home);
    const r = launch(id, CLOUD_ENV);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/repo/i);
    expect(taskState(home, id)).toBe("queued");
    expect(readTask(home, id)).toMatch(/error: \S/);
  });

  it("local_only: true → hata nedeni (local_only_reason) görünür; görev queued", () => {
    writeCard(home, "alpha", { repo: "iamhankaya/vlad", local_only: "true", local_only_reason: '"WPF, bulutta derlenemez"' });
    const id = newTask(home);
    const r = launch(id, CLOUD_ENV);
    expect(r.code).toBe(1);
    const err = JSON.parse(r.err).error as string;
    expect(err).toMatch(/local_only|yalnızca yerel/i);
    expect(err).toContain("WPF, bulutta derlenemez");
    expect(taskState(home, id)).toBe("queued");
  });

  it("kart şeması opsiyonel repo (owner/name), local_only ve local_only_reason kabul eder; bozuk repo reddedilir", () => {
    writeCard(home, "alpha", { repo: "iamhankaya/vlad", local_only: "false" });
    const f = join(home, "bad.md");
    writeFileSync(f, `---\nslug: alpha\nname: a\npath: x\nrepo: not a repo\nstack: []\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
    expect(vlad(home, ["project", "write", "alpha", "--file", f, "--json"]).code).toBe(1);
  });

  it("repo/local_only içermeyen mevcut kartlar hâlâ geçerli (geriye uyum)", () => {
    writeCard(home, "alpha");
    expect(vlad(home, ["project", "list", "--json"]).code).toBe(0);
  });
});

describe.runIf(onLinux)("senaryo 11: cloud görevi cleanup", { timeout: 30_000 }, () => {
  it("done cloud görevinde cleanup hata vermez", () => {
    setLauncher("cloud");
    writeCard(home, "alpha", { repo: "iamhankaya/vlad" });
    const id = newTask(home);
    expect(launch(id, CLOUD_ENV).code).toBe(0);
    writeFileSync(join(home, "rapor.md"), "### Özet\nbitti\n");
    expect(vlad(home, ["task", "report", id, "--file", join(home, "rapor.md"), "--json"]).code).toBe(0);
    expect(vlad(home, ["task", "set", id, "done", "--json"]).code).toBe(0);
    const r = vlad(home, ["task", "cleanup", id, "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(readdirSync(join(home, "kb", "tasks")).length).toBeGreaterThan(0);
  });
});
