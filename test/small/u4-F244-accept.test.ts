// F-244 kabulü (T20261105-62; plan "F-244 arayüzü"): `unmergedCommits(repo, branch, base): number | null` src/tasks/launch-core.ts'te.
// Sayı = base'te olmayan, branch'e özgü commit sayısı; ref çözülemezse null (kanıt yok ⇒ dal korunur). U4a'ya kadar KIRMIZI (export yok).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as core from "../../src/tasks/launch-core.js";
import { rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
let base: string, repo: string;
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-u4f244-")));
  repo = join(base, "r"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a"), "1"); git(repo, "add", "."); git(repo, "commit", "-qm", "c1");
});
afterEach(() => rmTemp(base));
const commit = (name: string) => { writeFileSync(join(repo, name), name); git(repo, "add", "."); git(repo, "commit", "-qm", name); };
type Fn = (repo: string, branch: string, base: string) => number | null;
const fn = (): Fn => {
  const f = (core as unknown as { unmergedCommits?: Fn }).unmergedCommits;
  expect(typeof f, "launch-core.ts unmergedCommits export etmeli (F-244)").toBe("function");
  return f!;
};

describe("F-244 unmergedCommits", () => {
  it("dal tabanla aynı noktada ⇒ 0", () => {
    git(repo, "branch", "vlad/x");
    expect(fn()(repo, "vlad/x", "main")).toBe(0);
  });
  it("taban dalın önünde ilerlemişse (dalın kendi commit'i yok) ⇒ 0: taban kanıtlı, -D güvenli", () => {
    git(repo, "branch", "vlad/x");
    commit("m1"); commit("m2"); // main ilerledi, vlad/x geride kaldı
    expect(fn()(repo, "vlad/x", "main")).toBe(0);
  });
  it("dalın tabanda olmayan commit'leri var ⇒ sayı (dal korunmalı)", () => {
    git(repo, "checkout", "-qb", "vlad/x");
    commit("w1"); commit("w2");
    git(repo, "checkout", "-q", "main");
    expect(fn()(repo, "vlad/x", "main")).toBe(2);
  });
  it("dal tabana merge edilmişse ⇒ 0", () => {
    git(repo, "checkout", "-qb", "vlad/x"); commit("w1"); git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge", "vlad/x");
    expect(fn()(repo, "vlad/x", "main")).toBe(0);
  });
  it("kanıt yok (olmayan dal ya da olmayan taban) ⇒ null, 0 değil", () => {
    expect(fn()(repo, "vlad/yok", "main")).toBeNull();
    git(repo, "branch", "vlad/x");
    expect(fn()(repo, "vlad/x", "taban-yok")).toBeNull();
  });
});
