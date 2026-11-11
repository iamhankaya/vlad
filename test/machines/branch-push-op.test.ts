import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchPushArgv, branchPushVerdict, pushTaskBranch } from "../../src/agent/ops/branch-push.js";
import { RemoteError } from "../../src/fleet/types.js";
import { fetchBranchHead } from "../../src/machines/remote.js";
import { rmTemp } from "../helpers.js";

// F-vlad-314 uygulama: gerçek bare origin + iki klon (işçi / beyin); hiçbir gerçek dizine dokunulmaz.
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const ID = "T20261111-77";
const BR = `vlad/${ID}`;

let base: string, origin: string, worker: string, brain: string;
const commit = (cwd: string, f: string, c: string) => { writeFileSync(join(cwd, f), c); git(cwd, "add", "."); git(cwd, "commit", "-m", c); return git(cwd, "rev-parse", "HEAD"); };
const codeOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as RemoteError; } return null; };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-bp-")));
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

describe("branchPushArgv: yalnız <sha>:refs/heads/vlad/<id>; force/tag/mirror yok", () => {
  it("tam argv", () => {
    const sha = "a".repeat(40);
    expect(branchPushArgv(BR, sha)).toEqual(["push", "--porcelain", "--no-follow-tags", "origin", `${sha}:refs/heads/${BR}`]);
  });
});

describe("pushTaskBranch", () => {
  it("mutlu yol: dalı origin'e iter; ana dala dokunmaz", async () => {
    const head = commit(worker, "b.txt", "2");
    const main0 = git(origin, "rev-parse", "main");
    await expect(pushTaskBranch(worker, ID, head)).resolves.toEqual({ branch: BR, head, pushed: true, remote: "origin" });
    expect(git(origin, "rev-parse", BR)).toBe(head);
    expect(git(origin, "rev-parse", "main")).toBe(main0);
    expect(git(origin, "tag")).toBe("");
  });
  it("idempotent: origin zaten expectHead → pushed:false", async () => {
    const head = commit(worker, "b.txt", "2");
    await pushTaskBranch(worker, ID, head);
    await expect(pushTaskBranch(worker, ID, head)).resolves.toMatchObject({ pushed: false, head });
  });
  it("origin geride (ata) → fast-forward push", async () => {
    const h1 = commit(worker, "b.txt", "2");
    await pushTaskBranch(worker, ID, h1);
    const h2 = commit(worker, "c.txt", "3");
    await expect(pushTaskBranch(worker, ID, h2)).resolves.toMatchObject({ pushed: true });
    expect(git(origin, "rev-parse", BR)).toBe(h2);
  });
  it("origin'de ata olmayan farklı sha → conflict [diverged], origin değişmez (force yok)", async () => {
    const h1 = commit(worker, "b.txt", "2");
    await pushTaskBranch(worker, ID, h1);
    git(worker, "reset", "--hard", "main");
    const h2 = commit(worker, "d.txt", "other");
    const e = await codeOf(pushTaskBranch(worker, ID, h2));
    expect(e?.code).toBe("conflict");
    expect(e?.message).toContain("[diverged]");
    expect(git(origin, "rev-parse", BR)).toBe(h1);
  });
  it("dal ucu expectHead değil → failed [stale_tip], push yok", async () => {
    const head = commit(worker, "b.txt", "2");
    commit(worker, "c.txt", "3");
    const e = await codeOf(pushTaskBranch(worker, ID, head));
    expect(e?.code).toBe("failed");
    expect(e?.message).toContain("[stale_tip]");
    expect(git(origin, "branch", "--list", BR)).toBe("");
  });
  it("dal yok → not_found", async () => {
    git(worker, "checkout", "main");
    git(worker, "branch", "-D", BR);
    expect((await codeOf(pushTaskBranch(worker, ID, "a".repeat(40))))?.code).toBe("not_found");
  });
  it("origin yok → failed [no_origin]", async () => {
    const head = commit(worker, "b.txt", "2");
    git(worker, "remote", "remove", "origin");
    const e = await codeOf(pushTaskBranch(worker, ID, head));
    expect(e?.code).toBe("failed");
    expect(e?.message).toContain("[no_origin]");
  });
  it("ulaşılamayan origin → failed, mesaj yol/URL sızdırmaz", async () => {
    const head = commit(worker, "b.txt", "2");
    git(worker, "remote", "set-url", "origin", join(base, "yok.git"));
    const e = await codeOf(pushTaskBranch(worker, ID, head));
    expect(e?.code).toBe("failed");
    expect(e?.message).not.toContain(base);
  });
});

describe("branchPushVerdict (reconciler)", () => {
  it("origin'de expectHead → applied; yok → not-applied; başka sha → not-applied (yeniden deneme güvenli)", async () => {
    const head = commit(worker, "b.txt", "2");
    expect(branchPushVerdict(worker, BR, head)).toBe("not-applied");
    await pushTaskBranch(worker, ID, head);
    expect(branchPushVerdict(worker, BR, head)).toEqual({ verdict: "applied", result: { branch: BR, head, pushed: true, remote: "origin" } });
    expect(branchPushVerdict(worker, BR, "b".repeat(40))).toBe("not-applied");
  });
});

describe("fetchBranchHead (beyin)", () => {
  it("origin'den alır; FETCH_HEAD == expectHead; yerel refs/heads/vlad/<id> yaratılmaz", async () => {
    const head = commit(worker, "b.txt", "2");
    await pushTaskBranch(worker, ID, head);
    fetchBranchHead(brain, ID, head);
    expect(git(brain, "cat-file", "-t", head)).toBe("commit");
    expect(git(brain, "branch", "--list", BR)).toBe("");
  });
  it("FETCH_HEAD ≠ expectHead → hata", async () => {
    const head = commit(worker, "b.txt", "2");
    await pushTaskBranch(worker, ID, head);
    expect(() => fetchBranchHead(brain, ID, "b".repeat(40))).toThrow(/FETCH_HEAD/);
  });
  it("origin'de dal yok → hata", () => {
    expect(() => fetchBranchHead(brain, ID, "a".repeat(40))).toThrow(/fetch/);
  });
});
