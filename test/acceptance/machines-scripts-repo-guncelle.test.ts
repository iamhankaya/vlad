// Kabul (T20261109-06, çatı T20261109-03) KK3 / S1–S2: `agent-scripts/repo-guncelle.sh` (POSIX varyantı) gerçek git ile, yalnız geçici dizinde.
// Kaynak: spec raporu "repo-guncelle'nin manifeste girişi" — sonuç satırı `@@VLAD-RESULT@@ {ok, summary, repos[]}`; durumlar updated|current|skipped|error;
// neden: detached|no_upstream|dirty|diverged|agent_repo|fetch_failed|pull_failed; vlad klonu (VLAD_REPO) atlanır; `pull --ff-only`; sabit yol / Downloads dosyası yok.
// Betik Agent dışında doğrudan çalıştırılır (ortam sözleşmesi: VLAD_PARAM_ROOT, VLAD_REPO, VLAD_OP_ID, GIT_TERMINAL_PROMPT=0). Windows .ps1 koşumu gerçek makinede (rapor Açık noktalar).
// Uygulama (T20261109-07) yokken KIRMIZI beklenir: agent-scripts/repo-guncelle.sh yok.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmTemp } from "../helpers.js";

const SCRIPT = join(import.meta.dirname, "..", "..", "agent-scripts", "repo-guncelle.sh");
const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

interface Item { name: string; status: string; reason?: string; branch?: string; from?: string; to?: string }
let base = ""; let roots = ""; let home = "";
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-rg-")));
  roots = join(base, "my roots"); // boşluklu yol: tırnaklama güvencesi
  home = join(base, "home");
  mkdirSync(roots); mkdirSync(home);
});
afterEach(() => rmTemp(base));

/** origin (bare) + roots/<name> klonu; `other` ikinci klon (uzak tarafa commit atmak için). */
function mkRepo(name: string) {
  const origin = join(base, "origins", `${name}.git`);
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare", "-b", "main");
  const seed = join(base, "seeds", name);
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main"); writeFileSync(join(seed, "f.txt"), "1\n"); git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "i");
  git(seed, "remote", "add", "origin", origin); git(seed, "push", "-q", "-u", "origin", "main");
  const dir = join(roots, name);
  git(base, "clone", "-q", origin, dir);
  return {
    dir, origin,
    head: () => git(dir, "rev-parse", "HEAD"),
    /** uzak tarafa yeni commit (başka klondan) */
    pushRemote(file = "r.txt") { writeFileSync(join(seed, file), String(Math.random())); git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "remote"); git(seed, "push", "-q", "origin", "main"); return git(seed, "rev-parse", "HEAD"); },
  };
}

function runScript(env: Record<string, string> = {}) {
  const r = spawnSync("/bin/bash", ["--noprofile", "--norc", SCRIPT], {
    encoding: "utf8", cwd: base, timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", HOME: home, GIT_TERMINAL_PROMPT: "0", VLAD_PARAM_ROOT: roots, VLAD_REPO: join(base, "no-agent-repo"), VLAD_OP_ID: "op-rg", VLAD_SCRIPT: "repo-guncelle", VLAD_MACHINE: "t", ...env },
  });
  const lines = (r.stdout ?? "").split("\n").filter((l) => l !== "");
  let data: { ok: boolean; summary: string; repos: Item[] } | null = null;
  for (const l of lines.slice(-20).reverse()) { const m = /^@@VLAD-RESULT@@ (\{.*\})$/.exec(l); if (m) { data = JSON.parse(m[1]!); break; } }
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", data };
}
const item = (d: { repos: Item[] } | null, name: string): Item => {
  const x = d?.repos.find((r) => r.name === name);
  expect(x, `${name} sonuçta yok: ${JSON.stringify(d)}`).toBeDefined();
  return x!;
};

describe.skipIf(process.platform === "win32")("scripts KK3: repo-guncelle.sh (POSIX)", () => {
  it("betik dosyası var", () => { expect(existsSync(SCRIPT)).toBe(true); });

  it("geride kalan temiz repo güncellenir: status updated, from/to kısa sha, dal adı; çalışma ağacı yeni commit'te", () => {
    const a = mkRepo("alpha"); const before = a.head(); const after = a.pushRemote();
    const r = runScript();
    expect(r.code, r.err).toBe(0);
    expect(r.data).not.toBeNull();
    expect(r.data!.ok).toBe(true);
    const it = item(r.data, "alpha");
    expect(it.status).toBe("updated");
    expect(it.branch).toBe("main");
    expect(it.from!.length).toBeGreaterThanOrEqual(7); expect(before.startsWith(it.from!)).toBe(true);
    expect(it.to!.length).toBeGreaterThanOrEqual(7); expect(after.startsWith(it.to!)).toBe(true);
    expect(a.head()).toBe(after);
  });

  it("zaten güncel repo: current, HEAD değişmez", () => {
    const a = mkRepo("alpha"); const h = a.head();
    expect(item(runScript().data, "alpha")).toMatchObject({ status: "current" });
    expect(a.head()).toBe(h);
  });

  it("kirli (izlenen dosyada değişiklik) repo atlanır: skipped dirty; çalışma ağacı ve HEAD korunur", () => {
    const a = mkRepo("alpha"); a.pushRemote(); const h = a.head();
    writeFileSync(join(a.dir, "f.txt"), "yerel degisiklik\n");
    const r = runScript();
    expect(item(r.data, "alpha")).toMatchObject({ status: "skipped", reason: "dirty" });
    expect(a.head()).toBe(h);
    expect(readdirSync(a.dir)).not.toContain("r.txt");
    expect(git(a.dir, "diff", "--name-only")).toBe("f.txt");
  });

  it("detached HEAD atlanır: skipped detached", () => {
    const a = mkRepo("alpha"); a.pushRemote(); git(a.dir, "checkout", "-q", "--detach"); const h = a.head();
    expect(item(runScript().data, "alpha")).toMatchObject({ status: "skipped", reason: "detached" });
    expect(a.head()).toBe(h);
  });

  it("upstream'siz dal atlanır: skipped no_upstream", () => {
    const a = mkRepo("alpha"); git(a.dir, "checkout", "-q", "-b", "yerel-dal");
    expect(item(runScript().data, "alpha")).toMatchObject({ status: "skipped", reason: "no_upstream" });
  });

  it("ayrışmış (diverged) repo atlanır: skipped diverged; merge commit oluşmaz (--ff-only); toplam ok true kalır", () => {
    const a = mkRepo("alpha"); a.pushRemote();
    writeFileSync(join(a.dir, "y.txt"), "yerel\n"); git(a.dir, "add", "-A"); git(a.dir, "commit", "-q", "-m", "yerel"); const h = a.head();
    const r = runScript();
    expect(item(r.data, "alpha")).toMatchObject({ status: "skipped", reason: "diverged" });
    expect(a.head()).toBe(h);
    expect(git(a.dir, "rev-list", "--merges", "--count", "HEAD")).toBe("0");
    expect(r.data!.ok).toBe(true);
    expect(r.code).toBe(0);
  });

  it("fetch başarısız (uzak yok): fetch_failed nedeni; betik çökmez, diğer repolar yine işlenir", () => {
    const a = mkRepo("alpha"); const b = mkRepo("beta"); b.pushRemote();
    rmSync(a.origin, { recursive: true, force: true });
    const r = runScript();
    expect(r.code, r.err).toBe(0);
    const x = item(r.data, "alpha");
    expect(["error", "skipped"]).toContain(x.status);
    expect(x.reason).toBe("fetch_failed");
    expect(item(r.data, "beta").status).toBe("updated");
  });

  it("vlad klonu (VLAD_REPO) atlanır: skipped agent_repo; geride olsa bile dokunulmaz (kendini güncelleme vlad-guncelle'nin işi)", () => {
    const a = mkRepo("vlad"); a.pushRemote(); const h = a.head();
    const r = runScript({ VLAD_REPO: a.dir });
    expect(item(r.data, "vlad")).toMatchObject({ status: "skipped", reason: "agent_repo" });
    expect(a.head()).toBe(h);
  });

  it("karışık kök: her repo kendi durumunu alır; git olmayan klasör çökertmez; sentinel son 20 satırda; summary dolu", () => {
    const up = mkRepo("a-updated"); up.pushRemote();
    mkRepo("b-current");
    const dirty = mkRepo("c-dirty"); dirty.pushRemote(); writeFileSync(join(dirty.dir, "f.txt"), "x\n");
    const det = mkRepo("d-detached"); git(det.dir, "checkout", "-q", "--detach");
    mkdirSync(join(roots, "git-degil"));
    const r = runScript();
    expect(r.code, r.err).toBe(0);
    expect(r.data!.ok).toBe(true);
    expect(r.data!.summary.length).toBeGreaterThan(0);
    expect(item(r.data, "a-updated").status).toBe("updated");
    expect(item(r.data, "b-current").status).toBe("current");
    expect(item(r.data, "c-dirty")).toMatchObject({ status: "skipped", reason: "dirty" });
    expect(item(r.data, "d-detached")).toMatchObject({ status: "skipped", reason: "detached" });
    const names = r.data!.repos.map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("sabit C:\\dev yok, Downloads dosyası yok: HOME ve kök dışında hiçbir dosya yazılmaz", () => {
    const a = mkRepo("alpha"); a.pushRemote();
    expect(runScript().data, "betik çalışmış olmalı (boş geçişi önler)").not.toBeNull();
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(base)).not.toContain("Downloads");
  });

  it("boş kök klasörü: çökmez, ok true, repos boş", () => {
    const r = runScript();
    expect(r.code, r.err).toBe(0);
    expect(r.data).toMatchObject({ ok: true, repos: [] });
  });
});
