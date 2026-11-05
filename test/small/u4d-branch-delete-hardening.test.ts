// U4d (T20261105-79): F-vlad-257 + F-vlad-253. Dal silme kanıtı tam ref'le; detached HEAD tabanında dal korunur; geçersiz taban adı ⇒ kanıt yok;
// session_id biçimi doğrulanır; `worktree prune` yalnız tutucu girdi prunable ise.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resumeFlags } from "../../src/launcher/resume.js";
import { ASYNC_GIT, SYNC_GIT, launchCore, unmergedCommits, unmergedCommitsWith } from "../../src/tasks/launch-core.js";
import { rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-u4d-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a"), "1"); git(dir, "add", "."); git(dir, "commit", "-qm", "c1");
  git(dir, "checkout", "-qb", "vlad/x"); writeFileSync(join(dir, "w"), "w"); git(dir, "add", "."); git(dir, "commit", "-qm", "w");
  git(dir, "checkout", "-q", "main");
});
afterEach(() => rmTemp(dir));

describe("F-257 taban tam ref", () => {
  it("taban adıyla aynı adlı etiket tabanın yerine geçmez (sayı 0 değil 1)", async () => {
    git(dir, "branch", "vlad/p", "main");
    git(dir, "tag", "vlad/p", "vlad/x"); // etiket dalın ucunu gösterir; çıplak ad etikete çözülürdü ⇒ 0 ⇒ -D
    expect(unmergedCommits(dir, "vlad/x", "vlad/p")).toBe(1);
    expect(await unmergedCommitsWith(ASYNC_GIT, dir, "vlad/x", "vlad/p")).toBe(1);
  });
  it("detached HEAD tabanı ⇒ null (dal korunur)", async () => {
    git(dir, "checkout", "-q", "--detach", "vlad/x");
    expect(unmergedCommits(dir, "vlad/x", "HEAD")).toBeNull();
    expect(await unmergedCommitsWith(ASYNC_GIT, dir, "vlad/x", "HEAD")).toBeNull();
  });
  it("dal üzerindeki HEAD tabanı hâlâ sayar", () => {
    expect(unmergedCommits(dir, "vlad/x", "HEAD")).toBe(1);
  });
  it("geçersiz taban adı (seçenek, boşluk, ..) ⇒ null", async () => {
    for (const bad of ["--all", "a b", "vlad/../x", "x;y", ""]) {
      expect(unmergedCommits(dir, "vlad/x", bad), bad).toBeNull();
      expect(await unmergedCommitsWith(ASYNC_GIT, dir, "vlad/x", bad), bad).toBeNull();
    }
  });
});

describe("F-257 session_id biçimi", () => {
  it("geçerli kimlik geçer; boşluk/seçenek/ters eğik çizgi reddedilir", () => {
    expect(resumeFlags("abc-123_X")).toEqual(["--resume", "abc-123_X"]);
    for (const bad of ["a b", "--x y", "a;b", "a\nb", "../x"]) expect(() => resumeFlags(bad), bad).toThrow(/oturum kimliği/);
  });
});

describe("F-253 worktree prune kapsamı", () => {
  it("tutucu girdi prunable değilse prune çalıştırılmaz; prunable ise çalışır", async () => {
    const calls: string[][] = [];
    const spy = { ...SYNC_GIT, runGit: (c: string, a: string[], t?: number) => { calls.push(a); return SYNC_GIT.runGit(c, a, t); } };
    const wt = join(dir, "..", `wt-${Date.now()}`);
    const held = join(dir, "..", `held-${Date.now()}`);
    git(dir, "worktree", "add", "-q", held, "vlad/x");
    const launcher = { launch: async () => ({ method: "x" }) } as never;
    await expect(launchCore({ repo: dir, worktree: wt, branch: "vlad/x", adopt: true } as never, launcher, spy)).rejects.toThrow(/başka worktree/);
    expect(calls.some((a) => a[0] === "worktree" && a[1] === "prune")).toBe(false);
    rmSync(held, { recursive: true, force: true }); // elle silinmiş klasör ⇒ prunable
    calls.length = 0;
    await launchCore({ repo: dir, worktree: wt, branch: "vlad/x", adopt: true } as never, launcher, spy).catch(() => undefined);
    expect(calls.some((a) => a[0] === "worktree" && a[1] === "prune")).toBe(true);
    rmSync(wt, { recursive: true, force: true });
  });
});

