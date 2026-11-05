// U4c (T20261105-74): F-vlad-253 güvenlik notu + async varyant. base===branch ya da tam ref ⇒ kanıt yok (null), HEAD'e düşme yok;
// aynı adlı etiket dalın yerine geçmez; unmergedCommitsWith eşzamanlı sürümle aynı cevabı verir.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASYNC_GIT, unmergedCommits, unmergedCommitsWith } from "../../src/tasks/launch-core.js";
import { rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-u4c-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a"), "1"); git(dir, "add", "."); git(dir, "commit", "-qm", "c1");
  git(dir, "checkout", "-qb", "vlad/x"); writeFileSync(join(dir, "w"), "w"); git(dir, "add", "."); git(dir, "commit", "-qm", "w");
});
afterEach(() => rmTemp(dir));

describe("unmergedCommits koruması", () => {
  it("base dalın kendisi ⇒ null (0 değil)", () => {
    expect(unmergedCommits(dir, "vlad/x", "vlad/x")).toBeNull();
    expect(unmergedCommits(dir, "vlad/x", "refs/heads/vlad/x")).toBeNull();
  });
  it("aynı adlı etiket dalın yerine geçmez: dal yoksa null", () => {
    git(dir, "tag", "vlad/y", "main");
    expect(unmergedCommits(dir, "vlad/y", "main")).toBeNull();
  });
  it("async varyant eşzamanlıyla aynı", async () => {
    expect(await unmergedCommitsWith(ASYNC_GIT, dir, "vlad/x", "main")).toBe(1);
    expect(await unmergedCommitsWith(ASYNC_GIT, dir, "vlad/x", "vlad/x")).toBeNull();
    expect(await unmergedCommitsWith(ASYNC_GIT, dir, "vlad/yok", "main")).toBeNull();
  });
});
