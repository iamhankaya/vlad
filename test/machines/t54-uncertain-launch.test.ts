// T20261105-54 / F-vlad-242, F-vlad-243: belirsiz uzak launch kurtarması (pipeline integration meta verisi, kalan dal).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "../../src/agent/journal.js";
import { setAgentEnv } from "../../src/agent/ops/env.js";
import { launchOp, readRecord } from "../../src/agent/ops/launch.js";
import { opStatus } from "../../src/agent/ops/op-status.js";
import { defaultConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const ID = "T20261105-92";
const PARENT = "T20261105-90";

describe("worker: belirsiz launch kurtarması", () => {
  let base: string; let home: string; let repo: string; let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(["VLAD_HOME", "VLAD_KB_DIR", "VLAD_MACHINE"].map((k) => [k, process.env[k]]));
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-t54-")));
    const roots = join(base, "roots"); repo = join(roots, "alpha");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "f.txt"), "1"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "i");
    home = makeHome();
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ brain: "mac", worktreeDir: join(base, "wt"), machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, roots: [roots], worktreeDir: join(base, "wt") }] }));
    process.env.VLAD_MACHINE = "windows";
    const j = new Journal(join(base, "j.jsonl"), () => Date.now());
    j.start("op-u", "mac", "launch", "h"); j.finish("op-u", "done", undefined, { uncertain: true });
    setAgentEnv({ self: "windows", kind: "worker-agent", cfg: { ...defaultConfig(), brain: "mac" }, startedAt: Date.now(), build: "t", journal: j, now: () => Date.now() } as never);
  });
  afterEach(() => {
    setAgentEnv(undefined);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmTemp(base); rmTemp(home);
  });
  const args = (parent?: string) => ({
    taskId: ID, project: "alpha", repoName: "alpha", branch: `vlad/${ID}`, promptTemplate: "p", title: "t",
    base: parent ? { kind: "integration", parent } : { kind: "default", defaultBranch: "main" },
  });

  it("F-242: pipeline fazı launch ortasında kesilirse kurtarılan sonuç integration + çatı kaydını taşır", async () => {
    let mid: ReturnType<typeof readRecord> = null;
    // launcher açıldığı anda Agent çökmüş sayılır: kayıt sonuçsuz kalır
    const crash: Launcher = { async launch(_r: LaunchRequest) { mid = readRecord(ID); throw new Error("çöktü"); } };
    await expect(launchOp(args(PARENT), { from: "mac", opId: "op-u" }, { launcher: crash })).rejects.toThrow();
    // çöküşü canlandır: launchCore'un geri alması olmadan kalan kaydı yeniden yaz
    const rec = mid!;
    expect(rec).toBeTruthy();
    const wt = join(base, "wt", "x");
    git(repo, "worktree", "add", "-q", "-b", `vlad/${ID}`, wt, `vlad/${PARENT}`);
    const { writeFileSync: w, mkdirSync: m } = await import("node:fs");
    m(join(home, ".vlad-agent", "launches"), { recursive: true });
    w(join(home, ".vlad-agent", "launches", `${ID}.json`), JSON.stringify({ ...rec, worktree: wt }));
    const r = await opStatus({ target: "op-u" }, { from: "mac" }) as { state: string; result?: { integration?: { branch: string; worktree: string } } };
    expect(r.state).toBe("done");
    expect(r.result?.integration).toMatchObject({ branch: `vlad/${PARENT}` });
    expect(existsSync(r.result!.integration!.worktree)).toBe(true);
    expect(readRecord(PARENT)).toMatchObject({ branch: `vlad/${PARENT}`, worktree: r.result!.integration!.worktree });
  });

  const stranded = async (withCommit: boolean, integ = false) => {
    const crash: Launcher = { async launch() { throw new Error("çöktü"); } };
    let mid: ReturnType<typeof readRecord> = null;
    const spy: Launcher = { async launch(r) { mid = readRecord(ID); return crash.launch(r); } };
    await expect(launchOp(args(integ ? PARENT : undefined), { from: "mac", opId: "op-u" }, { launcher: spy })).rejects.toThrow();
    // dal kaldı, worktree yok (yarım kalmış launch)
    if (integ) { // entegrasyon dalı ana daldan ilerde: `branch -d` (HEAD'e göre) bunu reddederdi
      const iw = mid!.integration!.worktree; writeFileSync(join(iw, "i.txt"), "i"); git(iw, "add", "-A"); git(iw, "commit", "-q", "-m", "i");
    }
    git(repo, "branch", `vlad/${ID}`, integ ? `vlad/${PARENT}` : "main");
    if (withCommit) { const t = join(base, "tmp-wt"); git(repo, "worktree", "add", "-q", t, `vlad/${ID}`); writeFileSync(join(t, "n.txt"), "x"); git(t, "add", "-A"); git(t, "commit", "-q", "-m", "w"); git(repo, "worktree", "remove", "--force", t); }
    mkdirSync(join(home, ".vlad-agent", "launches"), { recursive: true });
    writeFileSync(join(home, ".vlad-agent", "launches", `${ID}.json`), JSON.stringify({ ...mid!, worktree: join(base, "yok") }));
  };

  it("F-243: dal kalmış, worktree yok, dalda kendi commit'i yok → dal silinir, kayıt düşer, aborted", async () => {
    await stranded(false);
    expect((await opStatus({ target: "op-u" }, { from: "mac" })).state).toBe("aborted");
    expect(readRecord(ID)).toBeNull();
    expect(git(repo, "branch", "--list", `vlad/${ID}`)).toBe("");
  });

  it("F-243: pipeline fazı — dal entegrasyon dalından kesilmiş, kendi commit'i yok → silinir (HEAD'e göre birleşmemiş olsa da)", async () => {
    await stranded(false, true);
    expect((await opStatus({ target: "op-u" }, { from: "mac" })).state).toBe("aborted");
    expect(readRecord(ID)).toBeNull();
    expect(git(repo, "branch", "--list", `vlad/${ID}`)).toBe("");
  });

  it("F-243: dalda commit varsa kayıt ve dal korunur; beyin 'sonuçsuz done' görür (release --force yolu), ağ hatası gibi görünmez", async () => {
    await stranded(true);
    const r = await opStatus({ target: "op-u" }, { from: "mac" });
    expect(r).toMatchObject({ state: "done" });
    expect((r as { result?: unknown }).result).toBeUndefined();
    expect(readRecord(ID)).not.toBeNull();
    expect(git(repo, "branch", "--list", `vlad/${ID}`)).toContain(`vlad/${ID}`);
  });
});
