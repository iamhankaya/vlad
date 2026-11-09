import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseResultLine } from "../../src/agent/scripts/run.js";

// agent-scripts/vlad-guncelle.sh (T20261109-10, spec S23/S24): pull --ff-only, npm ci, tsc --outDir dist-next, dist swap; hata halinde ESKİ dist kalır.
// Gerçek geçici git deposu + sahte uzak; `npm`/`npx` PATH'teki sahte betiklerdir (ağa/gerçek derlemeye çıkılmaz). .ps1 Windows'ta gerçek koşumda doğrulanır.
const posix = it.skipIf(process.platform === "win32");
const SCRIPT = resolve(import.meta.dirname, "..", "..", "agent-scripts", "vlad-guncelle.sh");
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "vlad-vg-"))); dirs.push(d); return d; };
const git = (cwd: string, ...a: string[]) => execFileSync("git", [...GIT, ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function world() {
  const base = tmp();
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const repo = join(base, "vlad");
  execFileSync("git", ["clone", "-q", remote, repo], { stdio: "ignore" });
  git(repo, "checkout", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), "{}");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\ndist-next/\ndist-old/\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "c1"); git(repo, "push", "-q", "-u", "origin", "main");
  mkdirSync(join(repo, "dist")); writeFileSync(join(repo, "dist", "cli.js"), "OLD");
  mkdirSync(join(repo, "node_modules")); writeFileSync(join(repo, "node_modules", "marker"), "m");
  const bin = join(base, "bin"); mkdirSync(bin);
  const log = join(base, "calls.log");
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("npm", `echo "npm $*" >> "${log}"\n[ -n "\${STUB_FAIL_NPM:-}" ] && { rm -rf node_modules; mkdir node_modules; echo half > node_modules/half; exit 1; }\nrm -rf node_modules; mkdir node_modules; echo fresh > node_modules/marker`);
  stub("npx", `echo "npx $*" >> "${log}"\nmkdir -p dist-next\n[ -n "\${STUB_FAIL_TSC:-}" ] && { echo half > dist-next/half.js; exit 2; }\necho NEW > dist-next/cli.js`);
  stub("mv", `[ -n "\${STUB_FAIL_MV:-}" ] && [ "$1" = "dist-next" ] && exit 1\nexec /bin/mv "$@"`);
  const other = join(base, "other");
  const remoteCommit = () => {
    if (!existsSync(other)) execFileSync("git", ["clone", "-q", remote, other], { stdio: "ignore" });
    else git(other, "pull", "-q", "--ff-only");
    writeFileSync(join(other, `f${Math.random()}`), "x");
    git(other, "add", "-A"); git(other, "commit", "-q", "-m", "r"); git(other, "push", "-q", "origin", "main");
  };
  const run = (env: Record<string, string> = {}) => {
    const r = spawnSync("/bin/bash", [SCRIPT], { encoding: "utf8", cwd: repo, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "", VLAD_REPO: repo, ...env } });
    const p = parseResultLine(r.stdout);
    expect(p.dataError, r.stdout + r.stderr).toBeUndefined();
    return { exit: r.status, data: p.data as { ok: boolean; step?: string; summary: string; from?: string; to?: string; changed?: boolean }, calls: existsSync(log) ? readFileSync(log, "utf8") : "", stderr: r.stderr };
  };
  const dist = (f: string) => (existsSync(join(repo, "dist", f)) ? readFileSync(join(repo, "dist", f), "utf8").trim() : null);
  return { repo, remoteCommit, run, dist, git: (...a: string[]) => git(repo, ...a) };
}

describe("vlad-guncelle.sh", () => {
  posix("yeni commit: pull + npm ci + derleme + swap; dist yeni, dist-next/dist-old kalmaz, sonuç from→to", () => {
    const w = world(); w.remoteCommit();
    const before = w.git("rev-parse", "--short", "HEAD").trim();
    const r = w.run();
    expect(r.exit).toBe(0);
    expect(r.data).toMatchObject({ ok: true, from: before, changed: true });
    expect(r.data.to).not.toBe(before);
    expect(r.calls).toMatch(/npm ci/);
    expect(r.calls).toMatch(/npx --no-install tsc.*--outDir dist-next/);
    expect(w.dist("cli.js")).toBe("NEW");
    expect(existsSync(join(w.repo, "dist-next"))).toBe(false);
  });
  posix("geri alma yedekleri silinmez: dist-old (eski dist) ve node_modules-old; temizliği yeni süreç açılınca Agent yapar", () => {
    const w = world(); w.remoteCommit();
    expect(w.run().data.ok).toBe(true);
    expect(readFileSync(join(w.repo, "dist-old", "cli.js"), "utf8")).toBe("OLD");
    expect(readFileSync(join(w.repo, "node_modules-old", "marker"), "utf8")).toBe("m");
    expect(readFileSync(join(w.repo, "node_modules", "marker"), "utf8").trim()).toBe("fresh");
    expect(existsSync(join(w.repo, ".vlad-npm-ci-running"))).toBe(false);
  });
  posix("zaten güncel ve dist bu HEAD'den derlenmiş: hiçbir şey yapmaz (changed:false)", () => {
    const w = world(); w.remoteCommit();
    expect(w.run().data.ok).toBe(true);
    const r = w.run();
    expect(r.data).toMatchObject({ ok: true, changed: false });
    expect(r.calls.match(/npm ci/g)).toHaveLength(1); // ikinci koşuda tekrar yok
  });
  posix("önceki koşuda derleme başarısız olduysa (HEAD ilerlemiş, dist eski) güncel görünse de yeniden derler", () => {
    const w = world(); w.remoteCommit();
    expect(w.run({ STUB_FAIL_TSC: "1" }).data).toMatchObject({ ok: false, step: "build" });
    const r = w.run();
    expect(r.data).toMatchObject({ ok: true, changed: true });
    expect(w.dist("cli.js")).toBe("NEW");
  });
  posix("derleme hatası: ok:false step:build, ESKİ dist aynen kalır, dist-next temizlenir, çıkış ≠ 0", () => {
    const w = world(); w.remoteCommit();
    const r = w.run({ STUB_FAIL_TSC: "1" });
    expect(r.exit).not.toBe(0);
    expect(r.data).toMatchObject({ ok: false, step: "build" });
    expect(w.dist("cli.js")).toBe("OLD");
    expect(existsSync(join(w.repo, "dist-next"))).toBe(false);
  });
  posix("npm ci hatası: ok:false step:install, eski dist kalır, derleme denenmez", () => {
    const w = world(); w.remoteCommit();
    const r = w.run({ STUB_FAIL_NPM: "1" });
    expect(r.data).toMatchObject({ ok: false, step: "install" });
    expect(w.dist("cli.js")).toBe("OLD");
    expect(r.calls).not.toMatch(/npx/);
    expect(readFileSync(join(w.repo, "node_modules", "marker"), "utf8")).toBe("m"); // yarım node_modules atılır, eskisi geri gelir
    expect(existsSync(join(w.repo, "node_modules", "half"))).toBe(false);
    expect(existsSync(join(w.repo, "node_modules-old"))).toBe(false);
    expect(existsSync(join(w.repo, ".vlad-npm-ci-running"))).toBe(false);
  });
  posix("kirli izlenen dosya: ok:false step:dirty, pull/npm hiç çalışmaz", () => {
    const w = world(); w.remoteCommit();
    writeFileSync(join(w.repo, "package.json"), "{\"x\":1}");
    const r = w.run();
    expect(r.data).toMatchObject({ ok: false, step: "dirty" });
    expect(r.calls).toBe("");
    expect(w.dist("cli.js")).toBe("OLD");
  });
  posix("ayrışmış dal (ff yapılamaz): ok:false step:pull, eski dist kalır", () => {
    const w = world(); w.remoteCommit();
    writeFileSync(join(w.repo, "yerel"), "y"); w.git("add", "-A"); w.git("commit", "-q", "-m", "yerel");
    const r = w.run();
    expect(r.data).toMatchObject({ ok: false, step: "pull" });
    expect(r.calls).toBe("");
    expect(w.dist("cli.js")).toBe("OLD");
  });
  posix("upstream yok / detached / VLAD_REPO yok: ok:false (setup)", () => {
    const w = world();
    w.git("checkout", "-q", "--detach");
    expect(w.run().data).toMatchObject({ ok: false, step: "detached" });
    w.git("checkout", "-q", "main"); w.git("branch", "--unset-upstream");
    expect(w.run().data).toMatchObject({ ok: false, step: "no_upstream" });
    expect(w.run({ VLAD_REPO: "/yok/boyle/dizin" }).data).toMatchObject({ ok: false, step: "setup" });
  });
  posix("önceki koşudan kalan dist-old swap'ı engellemez; yerine şimdiki eski dist geçer", () => {
    const w = world(); w.remoteCommit();
    mkdirSync(join(w.repo, "dist-old")); writeFileSync(join(w.repo, "dist-old", "eski"), "x");
    expect(w.run().data.ok).toBe(true);
    expect(existsSync(join(w.repo, "dist-old", "eski"))).toBe(false);
    expect(readFileSync(join(w.repo, "dist-old", "cli.js"), "utf8")).toBe("OLD");
  });
  posix("npm ci yarıda kesilmişse (işaret dosyası + node_modules-old) bir sonraki koşu başında eski node_modules geri gelir", () => {
    const w = world();
    rmSync(join(w.repo, "node_modules"), { recursive: true });
    mkdirSync(join(w.repo, "node_modules")); writeFileSync(join(w.repo, "node_modules", "yarim"), "x");
    mkdirSync(join(w.repo, "node_modules-old")); writeFileSync(join(w.repo, "node_modules-old", "marker"), "orig");
    writeFileSync(join(w.repo, ".vlad-npm-ci-running"), "");
    writeFileSync(join(w.repo, "package.json"), "{\"kirli\":1}"); // koşu 'dirty' ile erken biter; geri yükleme ondan ÖNCE olmalı
    expect(w.run().data).toMatchObject({ ok: false, step: "dirty" });
    expect(readFileSync(join(w.repo, "node_modules", "marker"), "utf8")).toBe("orig");
    expect(existsSync(join(w.repo, "node_modules", "yarim"))).toBe(false);
    expect(existsSync(join(w.repo, ".vlad-npm-ci-running"))).toBe(false);
  });
  posix("dal varsayılan dal değilse ya da upstream origin/<varsayılan dal> değilse: ok:false step:branch, hiçbir şey çalışmaz", () => {
    const w = world(); w.remoteCommit();
    w.git("checkout", "-q", "-b", "feat"); w.git("push", "-q", "-u", "origin", "feat");
    const a = w.run();
    expect(a.data).toMatchObject({ ok: false, step: "branch" });
    expect(a.calls).toBe("");
    w.git("checkout", "-q", "main"); w.git("branch", "-q", "-u", "origin/feat");
    expect(w.run().data).toMatchObject({ ok: false, step: "branch" });
    expect(w.dist("cli.js")).toBe("OLD");
  });
  posix("npm ci başarılı ama tsc başarısız: eski node_modules geri gelir, yedek ve işaret kalmaz, eski dist korunur (Codex P1)", () => {
    const w = world(); w.remoteCommit();
    const r = w.run({ STUB_FAIL_TSC: "1" });
    expect(r.data).toMatchObject({ ok: false, step: "build" });
    expect(readFileSync(join(w.repo, "node_modules", "marker"), "utf8")).toBe("m");
    expect(existsSync(join(w.repo, "node_modules-old"))).toBe(false);
    expect(existsSync(join(w.repo, ".vlad-npm-ci-running"))).toBe(false);
    expect(w.dist("cli.js")).toBe("OLD");
  });
  posix("swap başarısız (dist-next dist'e taşınamadı): eski dist ve eski node_modules geri gelir (Codex P1)", () => {
    const w = world(); w.remoteCommit();
    const r = w.run({ STUB_FAIL_MV: "1" });
    expect(r.data).toMatchObject({ ok: false, step: "swap" });
    expect(w.dist("cli.js")).toBe("OLD");
    expect(readFileSync(join(w.repo, "node_modules", "marker"), "utf8")).toBe("m");
    expect(existsSync(join(w.repo, "node_modules-old"))).toBe(false);
    expect(existsSync(join(w.repo, ".vlad-npm-ci-running"))).toBe(false);
  });
  posix("önceki güncellemenin node_modules-old yedeği varsa üstüne yazılmaz: step:install, hiçbir şey çalışmaz (Codex P1)", () => {
    const w = world(); w.remoteCommit();
    mkdirSync(join(w.repo, "node_modules-old")); writeFileSync(join(w.repo, "node_modules-old", "marker"), "yedek");
    const r = w.run();
    expect(r.data).toMatchObject({ ok: false, step: "install" });
    expect(r.calls).toBe("");
    expect(readFileSync(join(w.repo, "node_modules-old", "marker"), "utf8")).toBe("yedek");
    expect(readFileSync(join(w.repo, "node_modules", "marker"), "utf8")).toBe("m");
  });
  posix("dist hiç yoksa (ilk kurulum) swap yine çalışır", () => {
    const w = world(); w.remoteCommit();
    rmSync(join(w.repo, "dist"), { recursive: true });
    expect(w.run().data.ok).toBe(true);
    expect(w.dist("cli.js")).toBe("NEW");
  });
});
