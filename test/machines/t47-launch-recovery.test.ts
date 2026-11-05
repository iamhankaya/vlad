// T20261105-47 / F-vlad-233: işçide "done + uncertain" (sonuçsuz) kalan launch görevi kilitlemez.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "../../src/agent/journal.js";
import { setAgentEnv } from "../../src/agent/ops/env.js";
import { opStatus } from "../../src/agent/ops/op-status.js";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { RemoteError } from "../../src/machines/index.js";
import type { AgentOp, RemoteTransport } from "../../src/machines/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask } from "../../src/tasks/index.js";
import { launchTask, releaseTask } from "../../src/tasks/launch.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const ID = "T20261105-91";

describe("worker op-status: sonuçsuz done (uncertain) gerçek duruma çözülür", () => {
  let base: string; let home: string; let repo: string; let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(["VLAD_HOME", "VLAD_KB_DIR", "VLAD_MACHINE"].map((k) => [k, process.env[k]]));
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-t47-")));
    const roots = join(base, "roots"); repo = join(roots, "alpha");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "f.txt"), "1"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "i");
    home = makeHome();
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, roots: [roots] }] }));
    process.env.VLAD_MACHINE = "windows";
  });
  afterEach(() => {
    setAgentEnv(undefined);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmTemp(base); rmTemp(home);
  });
  const env = (): void => {
    const j = new Journal(join(base, "j.jsonl"), () => Date.now());
    j.start("op-u", "mac", "launch", "h"); j.finish("op-u", "done", undefined, { uncertain: true });
    setAgentEnv({ self: "windows", kind: "worker-agent", cfg: { ...defaultConfig(), brain: "mac" }, startedAt: Date.now(), build: "t", journal: j, now: () => Date.now() } as never);
  };
  const putRecord = (worktree: string) => {
    mkdirSync(join(home, ".vlad-agent", "launches"), { recursive: true });
    writeFileSync(join(home, ".vlad-agent", "launches", `${ID}.json`), JSON.stringify({ taskId: ID, repo, worktree, branch: `vlad/${ID}`, opId: "op-u" }));
  };

  it("başlatma kaydı yok → aborted (yeniden denenebilir)", async () => {
    env();
    expect((await opStatus({ target: "op-u" }, { from: "mac" })).state).toBe("aborted");
  });
  it("kayıt var ama worktree/dal yok → aborted ve yetim kayıt silinir (yeni opId conflict almaz)", async () => {
    env();
    putRecord(join(base, "yok"));
    expect((await opStatus({ target: "op-u" }, { from: "mac" })).state).toBe("aborted");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(home, ".vlad-agent", "launches", `${ID}.json`))).toBe(false);
  });
  it("kayıt + worktree + dal var → done ve sonuç (beyin sahiplenir)", async () => {
    env();
    const wt = join(base, "wt"); git(repo, "worktree", "add", "-q", "-b", `vlad/${ID}`, wt);
    putRecord(wt);
    const r = await opStatus({ target: "op-u" }, { from: "mac" });
    expect(r).toMatchObject({ state: "done", result: { branch: `vlad/${ID}`, worktree: wt } });
  });
});

describe("beyin: işçi sonuçsuz done diyorsa release --force çıkış sağlar", () => {
  let repo: string; let home: string; let cfg: VladConfig;
  beforeEach(() => {
    home = makeHome();
    const base = mkdtempSync(join(tmpdir(), "vlad-t47b-"));
    repo = join(base, "alpha"); mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "a.txt"), "1"); git(repo, "add", "."); git(repo, "commit", "-q", "-m", "f");
    cfg = defaultConfig(); cfg.worktreeDir = join(base, "wt"); cfg.brain = "mac";
    cfg.machines = [{ name: "mac", os: "darwin", agent: { port: 7437 }, maxParallel: 1 }, { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, maxParallel: 1 }];
    writeProject("alpha", `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\nmachines: [windows]\n---\n\n## Özet\nx\n`);
  });
  afterEach(() => { rmTemp(join(repo, "..")); rmTemp(home); });
  const fake = (h: Partial<Record<AgentOp, (a: any) => unknown>>): RemoteTransport => ({
    async call(to, op, args, o) {
      const fn = h[op];
      if (!fn) throw new RemoteError("unreachable", "bağlanamadı", to);
      return { opId: o?.opId ?? "x", result: (await fn(args)) as any };
    },
  });
  const noopLauncher: Launcher = { async launch(_r: LaunchRequest) { return { ok: true, method: "fake" }; } };
  async function stuck() {
    const t = createTask({ project: "alpha", title: "G", kind: "dev", body: "## Tanım\nx\n" } as any);
    const id = t.data.id;
    const timeout = fake({ ping: () => ({}), launch: () => { throw new RemoteError("timeout", "yanıt yok", "windows"); } });
    await expect(launchTask(id, { launcher: noopLauncher, cfg, remote: { transport: timeout } })).rejects.toThrow();
    return id;
  }

  it("done (sonuçsuz): launch mesajı release --force'u gösterir", async () => {
    const id = await stuck();
    const tr = fake({ ping: () => ({}), "op-status": () => ({ state: "done" }) });
    await expect(launchTask(id, { launcher: noopLauncher, cfg, remote: { transport: tr } })).rejects.toThrow(/release .*--force/);
  });
  it("done (sonuçsuz): release --force olmadan reddeder, --force ile bırakır ve released_ops yazar", async () => {
    const id = await stuck();
    const tr = fake({ ping: () => ({}), "op-status": () => ({ state: "done" }) });
    await expect(releaseTask(id, { cfg, transport: tr })).rejects.toThrow(/--force/);
    const t = await releaseTask(id, { cfg, transport: tr, force: true });
    expect(t.data).toMatchObject({ state: "queued", machine: null, launch_op: null });
    expect(getTask(id).data.released_ops).toHaveLength(1);
  });
  it("done + sonuç: --force bile olsa reddeder (launch sahiplenir)", async () => {
    const id = await stuck();
    const tr = fake({ ping: () => ({}), "op-status": () => ({ state: "done", result: { branch: "b", worktree: "w" } }) });
    await expect(releaseTask(id, { cfg, transport: tr, force: true })).rejects.toThrow(/tamamlanmış|task launch/);
  });
});
