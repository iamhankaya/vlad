// Doğrulama fazı (T20261109-08, çatı T20261109-03): GERÇEK betikler (agent-scripts/ aynen) + gerçek beyin CLI → işçi Agent alt süreci + gerçek git.
// Önceki kabul testleri (machines-scripts-*) sahte betik gövdeleri kullanır; burada manifestteki repo-guncelle.sh / vlad-guncelle.sh koşar.
// Yalnız geçici dizin. KRİTİK: başarılı selfUpdate Agent üzerinden KOŞTURULMAZ: Agent yeniden başlatma yolu (watchdog) gerçek
// ~/Library/LaunchAgents/com.vlad.agent.plist'e `launchctl kickstart` atabilir; başarı yolu betiğin kendisiyle doğrudan (bash) sınanır.
// A: her zaman açık (ağ yok). B: REAL_TOOLCHAIN=1 ile gerçek `npm ci` + `tsc` (ağ gerekir).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverSelfUpdate } from "../../src/agent/ops/script.js";
import { scriptPlanId } from "../../src/agent/scripts/manifest.js";
import { parseResultLine } from "../../src/agent/scripts/run.js";
import { rmTemp } from "../helpers.js";
import { makeWorld, runVlad, type World } from "./machines-world.js";

const posix = process.platform !== "win32";
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const REAL_SCRIPTS = join(REPO_ROOT, "agent-scripts");
const PLAT = process.platform;
const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const GITIGNORE = ".vlad-agent/\nkb/\nnoop.jsonl\nclaude.json\nvlad.local.json\n";

let w: World | undefined;
const temps: string[] = [];
afterEach(async () => { await w?.cleanup(); w = undefined; for (const t of temps.splice(0)) rmTemp(t); });
const mktmp = (p: string) => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };

/** Bare origin + `n` ikinci klon; origin'e dışarıdan commit atmak için. */
function remoteOf(base: string, originName = "origin.git") {
  const origin = join(base, originName);
  return { origin, other: join(base, `other-${originName}`) };
}

// ───────────────────────── A: gerçek repo-guncelle + manifest, Agent üzerinden ─────────────────────────
interface Fx { origin: string; work: string; seed: string; pushRemote(file?: string): string }
/** worker home'u içine gerçek `agent-scripts/` (aynen) kopyalayıp origin'li git deposu kurar. */
function realScriptsRepo(home: string, base: string): Fx {
  const origin = join(base, "scripts-origin.git");
  mkdirSync(origin); git(origin, "init", "-q", "--bare", "-b", "main");
  git(home, "init", "-q", "-b", "main");
  git(home, "remote", "add", "origin", origin);
  writeFileSync(join(home, ".gitignore"), GITIGNORE);
  cpSync(REAL_SCRIPTS, join(home, "agent-scripts"), { recursive: true });
  git(home, "add", "-A"); git(home, "commit", "-q", "-m", "scripts"); git(home, "push", "-q", "-u", "origin", "main");
  const seed = join(base, "scripts-seed");
  git(base, "clone", "-q", origin, seed);
  return { origin, work: home, seed, pushRemote(f = "x.txt") { writeFileSync(join(seed, f), String(Math.random())); git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "r"); git(seed, "push", "-q", "origin", "main"); return git(seed, "rev-parse", "HEAD"); } };
}
/** roots altında origin'li depo; `pushRemote` uzağa yeni commit atar. */
function rootRepo(base: string, root: string, name: string) {
  const origin = join(base, "root-origins", `${name}.git`);
  mkdirSync(origin, { recursive: true }); git(origin, "init", "-q", "--bare", "-b", "main");
  const seed = join(base, "root-seeds", name);
  mkdirSync(seed, { recursive: true }); git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "f"), "1\n"); git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "i");
  git(seed, "remote", "add", "origin", origin); git(seed, "push", "-q", "-u", "origin", "main");
  const dir = join(root, name);
  git(base, "clone", "-q", origin, dir);
  return { dir, head: () => git(dir, "rev-parse", "HEAD"), pushRemote() { writeFileSync(join(seed, "r"), String(Math.random())); git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "r"); git(seed, "push", "-q", "origin", "main"); return git(seed, "rev-parse", "HEAD"); } };
}

async function realWorld() {
  w = await makeWorld({});
  const fx = realScriptsRepo(w.worker.home, w.base);
  await w.startAgents(["worker"]);
  const brain = (...argv: string[]) => runVlad(w!.brain, ["machine", ...argv], { timeoutMs: 90_000 });
  const manifest = JSON.parse(readFileSync(join(REAL_SCRIPTS, "manifest.json"), "utf8")) as { scripts: { name: string; platform: string; sha256: string }[] };
  const sha = (name: string) => manifest.scripts.find((s) => s.name === name && s.platform === PLAT)!.sha256;
  const plan = (name: string, params: Record<string, string> = {}) => scriptPlanId({ machine: "windows", name, platform: PLAT as never, sha256: sha(name), params });
  const root = dirname(w.workerRepo);
  return { w, fx, brain, plan, root };
}
const rows = (out: string): { name: string; status: string; reason?: string; from?: string; to?: string }[] => {
  const p = parseResultLine(JSON.parse(out).stdout ?? "");
  return (p.data as { repos: never[] }).repos;
};

describe.skipIf(!posix)("V-A: gerçek repo-guncelle.sh + gerçek manifest, beyin CLI → işçi Agent", () => {
  it("V1 scripts: gerçek manifestin girişleri sınıf/bütünlükle listelenir (sha256 gerçek dosyayla eşleşir)", async () => {
    const { brain } = await realWorld();
    const doc = JSON.parse((await brain("scripts", "windows", "--json")).out);
    const list: { name: string; class: string; integrity: string }[] = Array.isArray(doc) ? doc : doc.scripts;
    expect(list.find((s) => s.name === "repo-guncelle")).toMatchObject({ class: "write", integrity: "ok" });
    expect(list.find((s) => s.name === "vlad-guncelle")).toMatchObject({ class: "write", integrity: "ok" });
  });

  it("V2 write onay akışı + gerçek koşum: --plan çalıştırmaz; --confirmed ile updated/current/dirty/no_upstream doğru, klon gerçekten ilerler", async () => {
    const { brain, fx, plan, root } = await realWorld();
    const upd = rootRepo(w!.base, root, "r-upd"), cur = rootRepo(w!.base, root, "r-cur"), dirty = rootRepo(w!.base, root, "r-dirty");
    const target = upd.pushRemote(); dirty.pushRemote();
    writeFileSync(join(dirty.dir, "f"), "kirli\n");
    const before = { upd: upd.head(), dirty: dirty.head() };

    const p = await brain("run", "windows", "repo-guncelle", "--plan");
    expect(p.code, p.err).toBe(0);
    expect(p.out).toContain(plan("repo-guncelle"));
    expect(upd.head(), "--plan çağrı yapmaz").toBe(before.upd);

    const no = await brain("run", "windows", "repo-guncelle");
    expect(no.code).toBe(1);
    expect(no.err).toContain("approval");
    expect(upd.head(), "onaysız koşmaz").toBe(before.upd);

    const r = await brain("run", "windows", "repo-guncelle", "--confirmed", plan("repo-guncelle"), "--op-id", "v2-1", "--json");
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ exit: 0, timedOut: false });
    const rs = rows(r.out);
    expect(rs.find((x) => x.name === "r-upd")).toMatchObject({ status: "updated" });
    expect(rs.find((x) => x.name === "r-cur")).toMatchObject({ status: "current" });
    expect(rs.find((x) => x.name === "r-dirty")).toMatchObject({ status: "skipped", reason: "dirty" });
    expect(rs.find((x) => x.name === "alpha")).toMatchObject({ status: "skipped", reason: "no_upstream" });
    expect(upd.head()).toBe(target);
    expect(dirty.head(), "kirli depo ilerlemez").toBe(before.dirty);
    expect(readFileSync(join(dirty.dir, "f"), "utf8"), "kirli dosya bozulmaz").toBe("kirli\n");
    expect(cur.head()).toBe(git(cur.dir, "rev-parse", "origin/main"));

    // aynı opId: replay, betik tekrar koşmaz (uzağa yeni commit gelse de r-upd ilerlemez)
    upd.pushRemote();
    const again = await brain("run", "windows", "repo-guncelle", "--confirmed", plan("repo-guncelle"), "--op-id", "v2-1", "--json");
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain("replayed");
    expect(upd.head(), "replay'de pull yok").toBe(target);
    void fx;
  }, 120_000);

  it("V3 ret senaryoları uçtan uca: kayıtsız ad, kötü parametre, kök dışı root, işçi tarafında CLI — hiçbiri depoyu değiştirmez", async () => {
    const { brain, plan, root } = await realWorld();
    const upd = rootRepo(w!.base, root, "r-rej"); const target = upd.pushRemote(); const head0 = upd.head();
    const a = await brain("run", "windows", "rm-rf");
    expect(a.code).toBe(1); expect(a.err).toContain("unregistered");
    const b = await brain("run", "windows", "repo-guncelle", "--param", "bilinmeyen=1", "--confirmed", plan("repo-guncelle"));
    expect(b.code).toBe(1); expect(b.err).toMatch(/bad_param|unknown/);
    const c = await brain("run", "windows", "repo-guncelle", "--param", `root=${dirname(root)}`, "--confirmed", plan("repo-guncelle", { root: dirname(root) }));
    expect(c.code, "roots dışındaki root reddedilmeli").toBe(1);
    const d = await runVlad(w!.worker, ["machine", "run", "windows", "repo-guncelle", "--confirmed", plan("repo-guncelle")]);
    expect(d.code, "işçi kimliği betik koşturamaz").not.toBe(0);
    expect(upd.head()).toBe(head0);
    expect(target).not.toBe(head0);
  }, 120_000);

  it("V4 bütünlük/yayın reddi: yerel değiştirilmiş betik (dirty), manifest dışı commit (hash_mismatch), push edilmemiş commit (unpushed) → betik koşmaz", async () => {
    const { brain, fx, plan, root } = await realWorld();
    const upd = rootRepo(w!.base, root, "r-int"); upd.pushRemote(); const head0 = upd.head();
    const file = join(fx.work, "agent-scripts", "repo-guncelle.sh");
    const orig = readFileSync(file, "utf8");
    const run = () => brain("run", "windows", "repo-guncelle", "--confirmed", plan("repo-guncelle"), "--op-id", `v4-${Math.random()}`);

    writeFileSync(file, orig + "\necho pwned > \"$VLAD_REPO/pwned\"\n");           // 1) çalışma ağacında değişmiş
    const dirty = await run();
    expect(dirty.code).toBe(1); expect(dirty.err).toMatch(/dirty|hash_mismatch/);

    git(fx.work, "add", "-A"); git(fx.work, "commit", "-q", "-m", "tamper");        // 2) commit'li ama push'sız → unpushed (ya da hash)
    const unpushed = await run();
    expect(unpushed.code).toBe(1); expect(unpushed.err).toMatch(/unpushed|hash_mismatch/);

    git(fx.work, "push", "-q", "origin", "main");                                    // 3) push'lu ama manifest sha'sı eski → hash_mismatch
    const hash = await run();
    expect(hash.code).toBe(1); expect(hash.err).toContain("hash_mismatch");

    expect(existsSync(join(fx.work, "pwned")), "değiştirilmiş betik hiç koşmamalı").toBe(false);
    expect(upd.head()).toBe(head0);
  }, 120_000);
});

// ───────────────────────── vlad-guncelle: zaman aşımı geri alma (Agent üzerinden, npm yerine takılan shim) ─────────────────────────
describe.skipIf(!posix)("V-T: vlad-guncelle zaman aşımı → Agent kendi geri yüklemesini yapar (P1), gerçek betik + gerçek Agent", () => {
  it("V5 npm ci takılır, betik timeoutSec'te öldürülür: node_modules ve dist geri gelir, işaret/yedek/dist-next kalmaz, bakım bayrağı kalkar", async () => {
    w = await makeWorld({});
    const base = w.base, home = w.worker.home;
    // işçi VLAD_HOME'u = repo'nun gerçek klonu (origin: bare klon), npm yerine takılan shim
    const origin = join(base, "vg-origin.git");
    execFileSync("git", ["clone", "-q", "--bare", REPO_ROOT, origin], { stdio: "pipe" });
    const branch = git(origin, "symbolic-ref", "--short", "HEAD");
    git(home, "init", "-q"); git(home, "remote", "add", "origin", origin);
    git(home, "fetch", "-q", "origin");
    git(home, "checkout", "-q", "-f", "-B", branch, `origin/${branch}`);
    git(home, "branch", "-q", `--set-upstream-to=origin/${branch}`);
    git(home, "remote", "set-head", "origin", branch);
    w.writeConfig();                                             // checkout -f tracked vlad.config.json'u ezdi
    git(home, "update-index", "--skip-worktree", "vlad.config.json");
    writeFileSync(join(home, ".git", "info", "exclude"), ".vlad-agent/\nkb/\nvlad.local.json\nnoop.jsonl\nclaude.json\n");
    mkdirSync(join(home, "dist"), { recursive: true }); writeFileSync(join(home, "dist", "cli.js"), "OLD");
    mkdirSync(join(home, "node_modules"), { recursive: true }); writeFileSync(join(home, "node_modules", ".verify-marker"), "m");
    // manifest: vlad-guncelle (bu platform) timeoutSec=2 → origin'e commit; sonra bir tane daha, ki pull gerçekten değişiklik getirsin
    const other = join(base, "vg-other"); git(base, "clone", "-q", origin, other);
    const mf = join(other, "agent-scripts", "manifest.json");
    const m = JSON.parse(readFileSync(mf, "utf8")) as { scripts: { name: string; platform: string; timeoutSec: number }[] };
    m.scripts.find((s) => s.name === "vlad-guncelle" && s.platform === PLAT)!.timeoutSec = 2;
    writeFileSync(mf, JSON.stringify(m, null, 2) + "\n");
    git(other, "add", "-A"); git(other, "commit", "-q", "-m", "manifest 2sn"); git(other, "push", "-q", "origin", branch);
    git(home, "pull", "-q", "--ff-only");
    writeFileSync(join(other, "yeni-dosya"), "1"); git(other, "add", "-A"); git(other, "commit", "-q", "-m", "yeni"); git(other, "push", "-q", "origin", branch);
    // shim: npm takılır (kill ile öldürülene dek); npx/diğerleri gerçek
    const shim = join(base, "shim"); mkdirSync(shim);
    writeFileSync(join(shim, "npm"), "#!/bin/bash\nexec sleep 120\n"); chmodSync(join(shim, "npm"), 0o755);
    w.worker.env.PATH = `${shim}:${process.env.PATH ?? ""}`;
    await w.startAgents(["worker"]);

    const scripts = JSON.parse((await runVlad(w.brain, ["machine", "scripts", "windows", "--json"])).out);
    const list: { name: string; integrity: string }[] = Array.isArray(scripts) ? scripts : scripts.scripts;
    expect(list.find((s) => s.name === "vlad-guncelle")!.integrity, JSON.stringify(list)).toBe("ok");
    const man = JSON.parse(readFileSync(join(home, "agent-scripts", "manifest.json"), "utf8")) as { scripts: { name: string; platform: string; sha256: string }[] };
    const sha256 = man.scripts.find((s) => s.name === "vlad-guncelle" && s.platform === PLAT)!.sha256;
    const planId = scriptPlanId({ machine: "windows", name: "vlad-guncelle", platform: PLAT as never, sha256, params: {} });

    const r = await runVlad(w.brain, ["machine", "run", "windows", "vlad-guncelle", "--confirmed", planId, "--op-id", "vt-1", "--json"], { timeoutMs: 120_000 });
    expect(JSON.parse(r.out), r.err).toMatchObject({ timedOut: true, exit: 124 });
    // geri alma sonrası durum (betik npm ci'de öldürüldü: node_modules yedeğe alınmıştı, işaret kalmıştı)
    expect(readFileSync(join(home, "node_modules", ".verify-marker"), "utf8")).toBe("m");
    expect(readFileSync(join(home, "dist", "cli.js"), "utf8")).toBe("OLD");
    for (const f of ["node_modules-old", "dist-next", ".vlad-npm-ci-running"]) expect(existsSync(join(home, f)), f).toBe(false);
    // bakım bayrağı kalktı: ikinci write busy [maintenance] vermez (plan çıktısı ile bir read-benzeri sorgu yerine aynı betik yine kabul edilir)
    const again = await runVlad(w.brain, ["machine", "run", "windows", "vlad-guncelle", "--confirmed", planId, "--op-id", "vt-2", "--json"], { timeoutMs: 120_000 });
    expect(again.err + again.out).not.toContain("maintenance");
  }, 240_000);
});

// F-vlad-271 (açık bulgu, düzeltme bu fazda yok): swap'tan SONRA, işaret silinmeden kesilen güncelleme. `it.fails`: bulgu düzelince bu test
// "beklenmedik geçti" ile kırılır ve düz `it`'e çevrilmelidir. Gerçek davranış: node_modules eski geri gelir, dist yeni kalır (yeni kod + eski bağımlılık).
describe.skipIf(!posix)("V-F271: swap sonrası kesilme — kurtarma dist'i de tutarlı bırakmalı", () => {
  it.fails("F-vlad-271: işaret + node_modules-old + (yeni dist, dist-old) → kurtarma sonrası dist ile node_modules aynı nesilden olmalı", () => {
    const repo = mktmp("vlad-f271-");
    const put = (rel: string, v: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), v); };
    put("dist/cli.js", "NEW"); put("dist/.build-head", "newhead"); put("dist-old/cli.js", "OLD");
    put("node_modules/marker", "yeni-bagimlilik"); put("node_modules-old/marker", "eski-bagimlilik"); put(".vlad-npm-ci-running", "");
    recoverSelfUpdate(repo);
    const nm = readFileSync(join(repo, "node_modules", "marker"), "utf8");
    const dist = readFileSync(join(repo, "dist", "cli.js"), "utf8");
    expect([nm, dist]).toSatisfy(([a, b]: string[]) => (a === "eski-bagimlilik") === (b === "OLD"));
  });
});

// ───────────────────────── B: gerçek npm ci + tsc (opt-in) ─────────────────────────
const REAL = process.env.REAL_TOOLCHAIN === "1";
describe.skipIf(!posix || !REAL)("V-B: vlad-guncelle.sh gerçek `npm ci` + `tsc` (geçici klon; REAL_TOOLCHAIN=1)", () => {
  function product() {
    const base = mktmp("vlad-real-");
    const { origin } = remoteOf(base);
    execFileSync("git", ["clone", "-q", "--bare", REPO_ROOT, origin], { stdio: "pipe" });
    const branch = git(origin, "symbolic-ref", "--short", "HEAD");
    const work = join(base, "work"); git(base, "clone", "-q", origin, work);
    const other = join(base, "other"); git(base, "clone", "-q", origin, other);
    const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8", timeout: 600_000 });
    sh("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], work);
    sh("npx", ["--no-install", "tsc"], work);
    writeFileSync(join(work, "dist", ".verify-old"), "1");
    writeFileSync(join(work, "node_modules", ".verify-marker"), "m");
    const push = (file: string, content: string) => { mkdirSync(dirname(join(other, file)), { recursive: true }); writeFileSync(join(other, file), content); git(other, "add", "-A"); git(other, "commit", "-q", "-m", file); git(other, "push", "-q", "origin", branch); };
    const run = () => {
      const r = spawnSync("/bin/bash", [join(work, "agent-scripts", "vlad-guncelle.sh")], { cwd: work, encoding: "utf8", timeout: 900_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", VLAD_REPO: work } });
      const p = parseResultLine(r.stdout);
      expect(p.dataError, r.stdout + r.stderr).toBeUndefined();
      return { exit: r.status, data: p.data as { ok: boolean; step?: string; changed?: boolean; to?: string }, stderr: r.stderr };
    };
    return { work, push, run, head: () => git(work, "rev-parse", "HEAD") };
  }

  it("V6 başarı: yeni commit → gerçek derleme, dist yenilenir (.build-head = HEAD), eski dist/node_modules yedekte, derlenen CLI çalışır", () => {
    const p = product();
    p.push("src/zz-verify.ts", "export const verify = 1;\n");
    const r = p.run();
    expect(r.exit, r.stderr).toBe(0);
    expect(r.data).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(join(p.work, "dist", ".build-head"), "utf8")).toBe(p.head());
    expect(existsSync(join(p.work, "dist", "zz-verify.js"))).toBe(true);
    expect(existsSync(join(p.work, "dist-old", ".verify-old"))).toBe(true);
    expect(existsSync(join(p.work, "node_modules-old", ".verify-marker"))).toBe(true);
    expect(existsSync(join(p.work, ".vlad-npm-ci-running"))).toBe(false);
    expect(spawnSync(process.execPath, [join(p.work, "dist", "cli.js"), "--help"], { encoding: "utf8" }).status).toBe(0);
    const again = p.run();                         // yedek duruyorsa (Agent bekçisi silmedi) ama HEAD güncel + dist damgalı → changed:false
    expect(again.data).toMatchObject({ ok: true, changed: false });
  }, 600_000);

  it("V7 gerçek tsc hatası: step:build, eski dist ve eski node_modules aynen; düzeltici commit gelince bir sonraki koşu başarılı", () => {
    const p = product();
    p.push("src/zz-broken.ts", "export const x: number = \"a\";\n");
    const r = p.run();
    expect(r.exit).not.toBe(0);
    expect(r.data).toMatchObject({ ok: false, step: "build" });
    expect(existsSync(join(p.work, "dist", ".verify-old"))).toBe(true);
    expect(existsSync(join(p.work, "node_modules", ".verify-marker"))).toBe(true);
    for (const f of ["dist-next", "dist-old", "node_modules-old", ".vlad-npm-ci-running"]) expect(existsSync(join(p.work, f)), f).toBe(false);
    p.push("src/zz-broken.ts", "export const x: number = 1;\n");
    const ok = p.run();
    expect(ok.data, ok.stderr).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(join(p.work, "dist", ".build-head"), "utf8")).toBe(p.head());
  }, 900_000);
});
