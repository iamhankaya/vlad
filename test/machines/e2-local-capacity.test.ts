import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask } from "../../src/tasks/index.js";
import { launchTask } from "../../src/tasks/launch.js";
import { makeHome, rmTemp } from "../helpers.js";
import { CLI, makeHomePair, spawnVlad } from "./harness.js";

// Son kapı Codex 2. tur P2: beyin-yerel launch kapasiteyi kilit altında ayırır (maxParallel=1 → yalnız biri açılır).
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" });
const cardText = (repo: string) => `---
slug: alpha
name: Alpha
path: ${JSON.stringify(repo)}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
machines: [mac]
---

## Özet
x
`;
const mkRepo = () => {
  const base = mkdtempSync(join(tmpdir(), "vlad-e2-"));
  const repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  return { base, repo };
};
const cfgOf = (worktreeDir: string): VladConfig => ({
  ...defaultConfig(), worktreeDir, brain: "mac",
  machines: [{ name: "mac", os: "darwin", agent: { port: 7437 }, maxParallel: 1 }, { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, maxParallel: 1 }],
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("yerel launch kapasite rezervasyonu", () => {
  let base: string, repo: string, home: string, cfg: VladConfig;
  beforeEach(() => {
    home = makeHome();
    ({ base, repo } = mkRepo());
    cfg = cfgOf(join(base, "wt"));
    writeProject("alpha", cardText(repo));
  });
  afterEach(() => { rmTemp(base); rmTemp(home); });
  const mk = () => createTask({ project: "alpha", title: "G", kind: "dev", body: "## Tanım\nx\n" } as any);
  const slowLauncher = (): Launcher & { reqs: LaunchRequest[] } => {
    const reqs: LaunchRequest[] = [];
    return { reqs, async launch(r) { reqs.push(r); await sleep(150); return { ok: true, method: "fake" }; } };
  };

  it("maxParallel=1: eşzamanlı iki yerel launch'tan yalnız biri açılır, diğeri 'dolu' ile reddedilir", async () => {
    const [a, b] = [mk(), mk()];
    const l = slowLauncher();
    const res = await Promise.allSettled([a, b].map((t) => launchTask(t.data.id, { launcher: l, cfg })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(lost.reason)).toMatch(/dolu/);
    expect(l.reqs).toHaveLength(1);
    const states = [a, b].map((t) => getTask(t.data.id).data);
    expect(states.filter((d) => d.state === "running")).toHaveLength(1);
    const q = states.find((d) => d.state === "queued")!;
    expect(q.machine ?? null).toBeNull(); // rezervasyon geri bırakıldı
    expect(q.machine_reserved ?? null).toBeNull();
  });

  it("launcher hata verirse rezervasyon serbest kalır; sonraki launch açılır", async () => {
    const [a, b] = [mk(), mk()];
    const bad: Launcher = { async launch() { throw new Error("pencere açılamadı"); } };
    await expect(launchTask(a.data.id, { launcher: bad, cfg })).rejects.toThrow("pencere açılamadı");
    const t = getTask(a.data.id).data;
    expect(t.machine_reserved ?? null).toBeNull();
    expect(t.launch_op ?? null).toBeNull();
    await launchTask(b.data.id, { launcher: slowLauncher(), cfg });
    expect(getTask(b.data.id).data.state).toBe("running");
  });
});

describe("yerel launch kapasite rezervasyonu — eşzamanlı alt süreç", () => {
  it("iki `vlad task launch` süreci aynı anda: maxParallel=1 iken yalnız biri running olur", async () => {
    const { base, repo } = mkRepo();
    const p = makeHomePair({ config: cfgOf(join(base, "wt")) });
    try {
      writeFileSync(join(p.brain.home, "card.md"), cardText(repo));
      expect(spawnVlad(p.brain, ["project", "write", "alpha", "--file", join(p.brain.home, "card.md")]).code).toBe(0);
      const ids = [0, 1].map(() => JSON.parse(spawnVlad(p.brain, ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", "--json"], { stdin: "## Tanım\nx\n" }).out).id as string);
      const env = { ...process.env, ...p.brain.env, VLAD_LAUNCHER: "noop" };
      const runs = await Promise.all(ids.map((id) => new Promise<number | null>((res) => {
        const c = spawn(process.execPath, [CLI, "task", "launch", id, "--machine", "mac"], { env, stdio: "ignore" });
        c.on("exit", res);
      })));
      expect(runs.filter((c) => c === 0)).toHaveLength(1);
      const running = ids.filter((id) => /^state: running$/m.test(readFileSync(join(p.brain.kb, "tasks", `${id}.md`), "utf8")));
      expect(running).toHaveLength(1);
    } finally { p.cleanup(); rmTemp(dirname(repo)); }
  }, 60_000);
});
