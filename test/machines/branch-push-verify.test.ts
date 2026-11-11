import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBranchPushArgs, pushTaskBranch } from "../../src/agent/ops/branch-push.js";
import { fetchBranchHead } from "../../src/machines/remote.js";
import { rmTemp } from "../helpers.js";

// T20261111-53 doğrulama (F-vlad-314): gerçek bare origin + klonlar, yalnız geçici dizin; açık bulgular F-vlad-321/322'nin kanıt testleri.
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const ID = "T20261111-88";
const BR = `vlad/${ID}`;
let base: string, origin: string, worker: string, brain: string;
const commit = (cwd: string, f: string, c: string) => { writeFileSync(join(cwd, f), c); git(cwd, "add", "."); git(cwd, "commit", "-m", c); return git(cwd, "rev-parse", "HEAD"); };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-bpv-")));
  origin = join(base, "origin.git");
  git(base, "init", "--bare", "-b", "main", origin);
  worker = join(base, "worker");
  git(base, "clone", origin, worker);
  git(worker, "checkout", "-b", "main");
  commit(worker, "a.txt", "1");
  git(worker, "push", "origin", "main");
  brain = join(base, "brain");
  git(base, "clone", origin, brain);
  git(worker, "checkout", "-b", BR);
});
afterEach(() => rmTemp(base));

const ok = { taskId: ID, project: "alpha", repoName: "alpha", branch: BR, expectHead: "a".repeat(40) };

describe("parseBranchPushArgs: olumsuz şema", () => {
  it("geçerli istek kabul edilir (kontrol)", () => { expect(parseBranchPushArgs(ok)).toEqual(ok); });
  for (const [ad, patch] of [
    ["başka görevin dalı", { branch: "vlad/T20261111-89" }],
    ["ana dal", { branch: "main" }],
    ["+refspec", { branch: `+${BR}` }],
    ["refspec iki nokta", { branch: `${BR}:refs/heads/main` }],
    ["tam ref", { branch: `refs/heads/${BR}` }],
    ["sondaki satır sonu", { branch: `${BR}\n` }],
    ["etiket", { branch: `refs/tags/${BR}` }],
    ["büyük harfli sha", { expectHead: "A".repeat(40) }],
    ["kısa sha", { expectHead: "abc1234" }],
    ["sha yerine dal adı", { expectHead: "HEAD" }],
    ["opsiyon enjeksiyonu", { expectHead: "--force" + "a".repeat(34) }],
    ["fazladan alan (force)", { force: true }],
    ["fazladan alan (remote)", { remote: "https://evil.example/x.git" }],
    ["fazladan alan (refspec)", { refspec: "+HEAD:refs/heads/main" }],
  ] as const) {
    it(`reddeder: ${ad}`, () => { expect(() => parseBranchPushArgs({ ...ok, ...patch })).toThrow(); });
  }
  it("reddeder: dizi/null/dize gövde", () => {
    for (const v of [null, "x", [], 1]) expect(() => parseBranchPushArgs(v)).toThrow();
  });
  it("reddeder: eksik alan", () => {
    for (const k of Object.keys(ok)) { const { [k]: _, ...rest } = ok as Record<string, string>; expect(() => parseBranchPushArgs(rest)).toThrow(); }
  });
});

describe("pushTaskBranch: origin sertleştirme (F-vlad-322)", () => {
  it("[F-vlad-322 D] origin'de `x/refs/heads/vlad/<id>` kuyruk-eşleşen sahte dal varken gerçek dal yoksa: push yapılır, sahte uç yüzünden conflict/pushed:false olmaz", async () => {
    // ls-remote deseni ref'in SONUNA göre eşler; sahte ref ilk satırda gelirse lsRemoteSha yanlış sha'yı alır
    const stray = commit(worker, "s.txt", "stray");
    git(worker, "push", "origin", `${stray}:refs/heads/a/refs/heads/${BR}`);
    git(worker, "reset", "--hard", "main");
    const head = commit(worker, "b.txt", "2");
    const r = await pushTaskBranch(worker, ID, head);
    expect(r.pushed).toBe(true);
    expect(git(origin, "rev-parse", `refs/heads/${BR}`)).toBe(head);
  });
  it("[F-vlad-322 D] sahte dal expectHead'de ise 'zaten origin'de' (pushed:false) denmemeli; gerçek dal origin'de oluşmalı", async () => {
    const head = commit(worker, "b.txt", "2");
    git(worker, "push", "origin", `${head}:refs/heads/a/refs/heads/${BR}`);
    const r = await pushTaskBranch(worker, ID, head);
    expect(r.pushed).toBe(true);
    expect(git(origin, "rev-parse", `refs/heads/${BR}`)).toBe(head);
  });
  it("etiket/başka dal itilmez: origin'de yalnız vlad/<id> eklenir", async () => {
    git(worker, "tag", "v1");
    const head = commit(worker, "b.txt", "2");
    git(worker, "branch", "baska");
    await pushTaskBranch(worker, ID, head);
    expect(git(origin, "for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual(["refs/heads/main", `refs/heads/${BR}`].sort());
  });
});

describe("fetchBranchHead: beyin tarafı (F-vlad-321, F-vlad-322 B)", () => {
  it("[F-vlad-322 B] origin'de aynı adlı ETİKET vlad/<id> farklı sha'daysa dal yine de alınır (tam ref fetch)", async () => {
    const head = commit(worker, "b.txt", "2");
    git(worker, "push", "origin", `${head}:refs/heads/${BR}`);
    git(worker, "tag", "-a", "-m", "t", BR, "main");
    git(worker, "push", "origin", `refs/tags/${BR}`);
    expect(() => fetchBranchHead(brain, ID, head)).not.toThrow();
  });
  it("[F-vlad-321] kimlik bilgisi (parola ve token-kullanıcı) fetch hata iletisine girmez (bu git sürümünde git kendisi maskeliyor; gerilemeye karşı koruma)", () => {
    git(brain, "remote", "set-url", "origin", "http://GHPTOKEN999:GIZLISIFRE123@127.0.0.1:9/x.git");
    let msg = "";
    try { fetchBranchHead(brain, ID, "a".repeat(40)); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toBe("");
    expect(msg).not.toContain("GIZLISIFRE123");
    expect(msg).not.toContain("GHPTOKEN999");
  });
  it("[F-vlad-321] uzak URL'nin yol bölümü (kullanıcı/depo adı) fetch hata iletisine girmez", () => {
    git(brain, "remote", "set-url", "origin", "http://127.0.0.1:9/gizli/yol.git");
    let msg = "";
    try { fetchBranchHead(brain, ID, "a".repeat(40)); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toBe("");
    expect(msg).not.toContain("gizli/yol");
  });
  it("[F-vlad-321] yerel yol origin'i: hata iletisi dosya yolunu sızdırmaz", () => {
    git(brain, "remote", "set-url", "origin", join(base, "yok-boyle-bir-repo-xyz.git"));
    let msg = "";
    try { fetchBranchHead(brain, ID, "a".repeat(40)); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toBe("");
    expect(msg).not.toContain("yok-boyle-bir-repo-xyz");
  });
});
