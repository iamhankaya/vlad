import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseResultLine } from "../../src/agent/scripts/run.js";

// agent-scripts/repo-guncelle.sh (T20261109-07): gerçek geçici depolar + sahte uzak (bare). .ps1 Windows'ta gerçek koşumda doğrulanır.
const posix = it.skipIf(process.platform === "win32");
const SCRIPT = resolve(import.meta.dirname, "..", "..", "agent-scripts", "repo-guncelle.sh");
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "vlad-rg-"))); dirs.push(d); return d; };
const git = (cwd: string, ...a: string[]) => execFileSync("git", [...GIT, ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** root/<name>: bare uzak + klon; `remoteCommit()` uzağa yeni commit iter. */
function mkRepo(root: string, name: string) {
  const remote = join(tmp(), "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const dir = join(root, name);
  execFileSync("git", ["clone", "-q", remote, dir], { stdio: "ignore" });
  git(dir, "checkout", "-q", "-b", "main");
  writeFileSync(join(dir, "a"), "1");
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "c1"); git(dir, "push", "-q", "-u", "origin", "main");
  const other = join(tmp(), "other");
  const remoteCommit = () => {
    if (!realpathSync.native) return;
    try { git(tmp(), "clone", "-q", remote, other); } catch { /* zaten var */ }
    writeFileSync(join(other, `f${Math.random()}`), "x");
    git(other, "add", "-A"); git(other, "commit", "-q", "-m", "r"); git(other, "push", "-q", "origin", "main");
  };
  return { dir, remote, remoteCommit };
}

function run(env: Record<string, string>) {
  const out = execFileSync("/bin/bash", [SCRIPT], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
  const r = parseResultLine(out);
  expect(r.dataError).toBeUndefined();
  const data = r.data as { ok: boolean; summary: string; repos: { name: string; status: string; reason?: string; from?: string; to?: string }[] };
  return { data, byName: Object.fromEntries(data.repos.map((x) => [x.name, x])) };
}

describe("repo-guncelle.sh", () => {
  posix("güncel, geride, kirli, detached, upstream'siz, ayrışmış, uzak bozuk, agent deposu ve git olmayan klasör", () => {
    const root = tmp();
    mkdirSync(join(root, "plain-dir"));
    const cur = mkRepo(root, "guncel");
    const behind = mkRepo(root, "geride"); behind.remoteCommit();
    const dirty = mkRepo(root, "kirli"); dirty.remoteCommit(); writeFileSync(join(dirty.dir, "a"), "degisti");
    const det = mkRepo(root, "detached"); git(det.dir, "checkout", "-q", "--detach");
    const noup = mkRepo(root, "upstreamsiz"); git(noup.dir, "branch", "--unset-upstream");
    const div = mkRepo(root, "ayrisik"); div.remoteCommit(); writeFileSync(join(div.dir, "yerel"), "y"); git(div.dir, "add", "-A"); git(div.dir, "commit", "-q", "-m", "yerel");
    const broken = mkRepo(root, "bozuk"); rmSync(broken.remote, { recursive: true, force: true });
    const agent = mkRepo(root, "vlad"); agent.remoteCommit();
    void cur;

    const { data, byName } = run({ VLAD_PARAM_ROOT: root, VLAD_REPO: join(root, "vlad") });
    expect(data.ok).toBe(true);
    expect(byName["guncel"]).toMatchObject({ status: "current" });
    expect(byName["geride"]).toMatchObject({ status: "updated" });
    expect(byName["geride"]!.from).not.toBe(byName["geride"]!.to);
    expect(byName["kirli"]).toMatchObject({ status: "skipped", reason: "dirty" });
    expect(byName["detached"]).toMatchObject({ status: "skipped", reason: "detached" });
    expect(byName["upstreamsiz"]).toMatchObject({ status: "skipped", reason: "no_upstream" });
    expect(byName["ayrisik"]).toMatchObject({ status: "skipped", reason: "diverged" });
    expect(byName["bozuk"]).toMatchObject({ status: "error", reason: "fetch_failed" });
    expect(byName["vlad"]).toMatchObject({ status: "skipped", reason: "agent_repo" });
    expect(byName["plain-dir"]).toBeUndefined();
    expect(data.summary).toBe("8 repo: 1 guncellendi, 1 guncel, 5 atlandi, 1 hata");
    // gerçekten güncellendi, atlananlara dokunulmadı
    expect(git(behind.dir, "rev-parse", "--short", "HEAD").trim()).toBe(byName["geride"]!.to);
    expect(git(agent.dir, "log", "--oneline").trim().split("\n")).toHaveLength(1);
  });
  posix("VLAD_ROOTS (';' ayrık) kullanılır; var olmayan kök hata değildir; boş sonuç geçerli", () => {
    const a = tmp(), b = tmp();
    mkRepo(a, "x"); mkRepo(b, "y");
    const { byName } = run({ VLAD_ROOTS: `${a};${b};/yok/boyle/kok` });
    expect(Object.keys(byName).sort()).toEqual(["x", "y"]);
    expect(run({ VLAD_ROOTS: "" }).data).toMatchObject({ ok: true, repos: [] });
  });
  posix("tırnak/ters bölü içeren dizin adı geçerli JSON üretir", () => {
    const root = tmp();
    mkRepo(root, 'q"uo\\te');
    expect(run({ VLAD_PARAM_ROOT: root }).byName['q"uo\\te']).toMatchObject({ status: "current" });
  });
  posix("symlink alt dizin atlanır (kök dışına çıkış), gerçek depo güncellenir", () => {
    const root = tmp(), outside = tmp();
    const real = mkRepo(outside, "dis"); real.remoteCommit();
    symlinkSync(real.dir, join(root, "baglanti"));
    const ok = mkRepo(root, "ic"); ok.remoteCommit();
    const before = git(real.dir, "rev-parse", "HEAD");
    const { byName } = run({ VLAD_PARAM_ROOT: root });
    expect(byName.baglanti).toBeUndefined();
    expect(byName.ic.status).toBe("updated");
    expect(git(real.dir, "rev-parse", "HEAD")).toBe(before); // dış depo dokunulmadı (pull yok)
    expect(git(real.dir, "rev-parse", "origin/main")).toBe(before); // fetch de yok
  });
});
