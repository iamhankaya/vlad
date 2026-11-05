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

// Çağrı noktası KARAKTERİZASYONU (tasks/launch.ts cleanupTask): kendi commit'i olmayan iptal dalı silinir, olan korunur. NOT: sıradan görev dalı
// default_branch'ten değil HEAD'den kesildiği için bu senaryo 'taban HEAD'in önünde' durumunu GERÇEKTEN zorlamaz (yeşil geçer); gerçek entegrasyon-tabanlı
// durum (pipeline fazı) raporda açık nokta olarak bırakıldı. Kural kanıtı yukarıdaki unmergedCommits testlerindedir.
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { defaultConfig } from "../../src/kb/index.js";
import type { Launcher } from "../../src/launcher/index.js";
import { writeProject } from "../../src/projects/store.js";
import { cleanupTask, launchTask } from "../../src/tasks/launch.js";
import { createTask, getTask, setState } from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

describe("F-244 çağrı noktası: yerel cleanupTask, taban HEAD'in önünde", () => {
  let home: string, r: string, wtRoot: string;
  const launcher: Launcher = { async launch() { return { ok: true, method: "fake" }; } };
  beforeEach(() => {
    home = makeHome();
    const b = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-u4f244b-")));
    r = join(b, "alpha"); mkdirSync(r); wtRoot = join(b, "wt");
    git(r, "init", "-q", "-b", "main");
    writeFileSync(join(r, "a"), "1"); git(r, "add", "."); git(r, "commit", "-qm", "c1");
    git(r, "checkout", "-qb", "develop"); writeFileSync(join(r, "d"), "d"); git(r, "add", "."); git(r, "commit", "-qm", "develop önde");
    git(r, "checkout", "-q", "main"); // HEAD main'de, taban develop önde
    writeProject("alpha", `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(r)}\nstack: [ts]\nstatus: active\nautonomy: commit\ndefault_branch: develop\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
  });
  afterEach(() => { rmTemp(dirname(r)); rmTemp(home); });
  const cfg = () => { const c = defaultConfig(); c.worktreeDir = wtRoot; return c; };

  it("kendi commit'i olmayan dal silinir (yeniden launch engellenmez)", async () => {
    const t = createTask({ project: "alpha", title: "x", kind: "dev", body: "## Tanım\nx\n" });
    await launchTask(t.data.id, { launcher, cfg: cfg() });
    setState(t.data.id, "cancelled");
    cleanupTask(t.data.id, { closeWorker: () => {} });
    expect(git(r, "branch", "--list", `vlad/${t.data.id}`)).toBe("");
  });
  it("kendi commit'i olan dal korunur", async () => {
    const t = createTask({ project: "alpha", title: "x", kind: "dev", body: "## Tanım\nx\n" });
    await launchTask(t.data.id, { launcher, cfg: cfg() });
    const wt = getTask(t.data.id).data.worktree!;
    writeFileSync(join(wt, "w"), "w"); git(wt, "add", "."); git(wt, "commit", "-qm", "iş");
    setState(t.data.id, "cancelled");
    cleanupTask(t.data.id, { closeWorker: () => {} });
    expect(git(r, "branch", "--list", `vlad/${t.data.id}`)).toContain(`vlad/${t.data.id}`);
  });
  void rmSync;
});
