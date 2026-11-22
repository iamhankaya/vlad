import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, saveTask } from "../../src/tasks/index.js";
import { makeHome, rmTemp } from "../helpers.js";
import { spawnVlad } from "../support/spawn-vlad.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });

let base: string, repo: string, wtRoot: string, home: string;
const cfgFile = (extra: Record<string, unknown> = {}) =>
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ roots: [base], worktreeDir: wtRoot, ...extra }));
const run = (...args: string[]) => spawnVlad({ args, env: { VLAD_HOME: home } });

beforeEach(() => {
  home = makeHome();
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-cmcli-")));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  wtRoot = join(base, "wt");
  cfgFile();
  writeProject("alpha", `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
});
afterEach(() => { rmTemp(base); rmTemp(home); });

function mergedDone() {
  const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "## Tanım\nx\n" });
  const id = t.data.id, wt = join(wtRoot, id);
  git(repo, "worktree", "add", "-b", `vlad/${id}`, wt, "main");
  writeFileSync(join(wt, "f.txt"), "x"); git(wt, "add", "."); git(wt, "commit", "-m", "w");
  git(repo, "merge", "--no-ff", "-m", "m", `vlad/${id}`);
  const r = getTask(id); r.data.state = "done"; r.data.worktree = wt; saveTask(r);
  return { id, wt };
}

describe("vlad task cleanup --merged (F-vlad-375)", () => {
  it("--dry-run --json: aday ve boyutu verir, hiçbir şeye dokunmaz", () => {
    const a = mergedDone();
    const r = run("task", "cleanup", "--merged", "--dry-run", "--json");
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.dryRun).toBe(true);
    expect(j.items).toEqual([expect.objectContaining({ id: a.id, action: "remove" })]);
    expect(j.candidateBytes).toBeGreaterThan(0);
    expect(existsSync(a.wt)).toBe(true);
  });

  it("--json: worktree'yi kaldırır, dalı korur, kb kaydını temizler", () => {
    const a = mergedDone();
    const r = run("task", "cleanup", "--merged", "--json");
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.removed).toBe(1);
    expect(j.freedBytes).toBeGreaterThan(0);
    expect(existsSync(a.wt)).toBe(false);
    expect(git(repo, "branch", "--list", `vlad/${a.id}`)).toContain(a.id);
    expect(getTask(a.id).data.worktree).toBeNull();
  });

  it("--project süzgeci ve --merged ile ID birlikte reddi", () => {
    mergedDone();
    const none = JSON.parse(run("task", "cleanup", "--merged", "--dry-run", "--project", "beta", "--json").stdout);
    expect(none.items).toEqual([]);
    const bad = run("task", "cleanup", "T20260101-01", "--merged");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--merged/);
  });

  it("ID de --merged de yoksa açık hata verir", () => {
    const r = run("task", "cleanup");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--merged/);
  });
});

describe("vlad status disk uyarısı (F-vlad-375)", () => {
  it("boş alan eşiğin altındaysa --summary satırında UYARI ve temizlenebilir sayı; --json'da diskWarning", () => {
    mergedDone();
    cfgFile({ minFreeDiskGb: 1e9 }); // her diskin altında
    const s = run("status", "--summary", "--no-mark");
    expect(s.status, s.stderr).toBe(0);
    expect(s.stdout).toMatch(/UYARI: disk boş alanı [\d.]+ GB \(eşik 1000000000 GB/);
    expect(s.stdout).toMatch(/temizlenebilir 1 worktree/);
    const j = JSON.parse(run("status", "--summary", "--no-mark", "--json").stdout);
    expect(j.diskWarning.cleanable.count).toBe(1);
  });

  it("eşik altında değilse satır ve alan yok", () => {
    cfgFile({ minFreeDiskGb: 0.000001 });
    const s = run("status", "--summary", "--no-mark");
    expect(s.stdout).not.toMatch(/disk boş alanı/);
    expect(JSON.parse(run("status", "--summary", "--no-mark", "--json").stdout).diskWarning).toBeUndefined();
  });

  it("--hook: SessionStart JSON'unda da uyarı görünür", () => {
    cfgFile({ minFreeDiskGb: 1e9 });
    const h = JSON.parse(run("status", "--summary", "--hook", "--no-mark").stdout);
    expect(h.hookSpecificOutput.additionalContext).toMatch(/UYARI: disk boş alanı/);
  });
});
