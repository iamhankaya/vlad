import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import { RemoteError } from "../../src/machines/index.js";
import type { AgentOp, RemoteTransport } from "../../src/machines/index.js";
import { markCleaned, remoteCleanup, remoteClose, remoteResume, syncKb } from "../../src/machines/remote.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, resumePrepare, setState } from "../../src/tasks/index.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

interface Call { to: string; op: AgentOp; args: any }
const fake = (reply: (c: Call) => unknown = () => ({})): RemoteTransport & { calls: Call[] } => {
  const calls: Call[] = [];
  return { calls, async call(to, op, args) { const c = { to, op, args }; calls.push(c); return { opId: "o", result: reply(c) as never }; } };
};

let base: string; let home: string; let saved: Record<string, string | undefined>;
const card = (slug: string, path: string) => writeProject(slug, `---
slug: ${slug}
name: ${slug}
path: ${JSON.stringify(path)}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`);
beforeEach(() => {
  saved = { VLAD_KB_DIR: process.env.VLAD_KB_DIR };
  base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-c2r-")));
  home = makeHome();
  card("alpha", join(base, "repos", "alpha")); card("beta", join(base, "repos", "beta"));
});
afterEach(() => { if (saved.VLAD_KB_DIR === undefined) delete process.env.VLAD_KB_DIR; else process.env.VLAD_KB_DIR = saved.VLAD_KB_DIR; rmTemp(base); rmTemp(home); });

describe("machines:C2 syncKb (beyin)", () => {
  const setupKb = (withUpstream: boolean) => {
    const kb = join(base, "kb"); mkdirSync(kb);
    if (withUpstream) {
      const origin = join(base, "origin.git"); mkdirSync(origin); git(origin, "init", "--bare", "-b", "main");
      git(kb, "init", "-q", "-b", "main"); git(kb, "remote", "add", "origin", origin);
      writeFileSync(join(kb, "a.md"), "1"); git(kb, "add", "-A"); git(kb, "commit", "-q", "-m", "seed"); git(kb, "push", "-q", "-u", "origin", "main");
    } else { git(kb, "init", "-q", "-b", "main"); writeFileSync(join(kb, "a.md"), "1"); git(kb, "add", "-A"); git(kb, "commit", "-q", "-m", "seed"); }
    process.env.VLAD_KB_DIR = kb;
    return kb;
  };

  it("kb değişikliğini commit+push eder, işçiye push edilmiş HEAD sha'sını bildirir", async () => {
    const kb = setupKb(true);
    writeFileSync(join(kb, "yeni.md"), "x");
    const t = fake();
    await syncKb(t, "windows");
    const head = git(kb, "rev-parse", "HEAD");
    expect(git(kb, "rev-list", "--count", "@{u}..HEAD")).toBe("0");
    expect(t.calls).toEqual([{ to: "windows", op: "kb-sync", args: { expectSha: head } }]);
  });

  it("upstream yoksa hata verir ve işçiye hiçbir şey gitmez", async () => {
    setupKb(false);
    const t = fake();
    await expect(syncKb(t, "windows")).rejects.toThrow(/upstream|push/);
    expect(t.calls).toHaveLength(0);
  });

  it("işçi kb-sync'i reddederse hata yükselir (launch reddedilir)", async () => {
    setupKb(true);
    const t: RemoteTransport = { call: async () => { throw new RemoteError("failed", "failed: işçi kb ağacı kirli"); } };
    await expect(syncKb(t, "windows")).rejects.toMatchObject({ code: "failed" });
  });
});

describe("machines:C2 uzak close/resume/cleanup (beyin)", () => {
  const cfg: VladConfig = { ...defaultConfig(), brain: "mac", workerAutoCompact: "300k" } as VladConfig;
  const mkRunning = (project = "alpha", extra: Record<string, unknown> = {}) => {
    const id = createTask({ project, title: "G", kind: "dev", body: "## Tanım\nx\n", ...extra } as any).data.id;
    setState(id, "running", { branch: `vlad/${id}`, worktree: "C:\\wt\\x", machine: "windows" } as any);
    return id;
  };

  it("remoteClose yalnız taskId gönderir ve öldürülen pid'leri döner", async () => {
    const t = fake(() => ({ killed: [4] }));
    expect(await remoteClose(t, "windows", "T20261101-61")).toEqual([4]);
    expect(t.calls).toEqual([{ to: "windows", op: "close", args: { taskId: "T20261101-61" } }]);
  });

  it("remoteResume: şablon işçide dolacak yer tutucularla gider; repoName kartın yolundan; yol göndermez", async () => {
    const id = mkRunning();
    const t = fake(() => ({ worktree: "W", method: "m", dirty: [] }));
    const plan = resumePrepare(id);
    const r = await remoteResume(t, "windows", getTask(id), { ...plan, sessionId: "s-1" }, cfg);
    expect(r).toEqual({ worktree: "W", method: "m", dirty: [] });
    const a = t.calls[0]!.args;
    expect(t.calls[0]!.op).toBe("resume");
    expect(a).toMatchObject({ taskId: id, project: "alpha", repoName: "alpha", sessionId: "s-1", autoCompact: "300k" });
    expect(a.promptTemplate).toContain("{{WORKTREE}}");
    expect(a.promptTemplate).toContain("{{DIRTY_LINE}}");
    expect(Object.keys(a)).not.toContain("worktree");
  });

  it("remoteCleanup: görev + pipeline faz projeleri için terminal:true; kaydı olmayan (forbidden) proje atlanır", async () => {
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "## Tanım\nx\n" } as any).data.id;
    createTask({ project: "beta", title: "F", kind: "dev", parent: pipe, body: "## Tanım\nx\n" } as any);
    setState(pipe, "cancelled" as any);
    const t = fake((c) => { if (c.args.project === "beta") throw new RemoteError("forbidden", "forbidden: kayıt yok"); return { removed: true }; });
    await remoteCleanup(t, "windows", getTask(pipe));
    expect(t.calls.map((c) => [c.op, c.args.project, c.args.repoName, c.args.terminal])).toEqual([["cleanup", "beta", "beta", true], ["cleanup", "alpha", "alpha", true]]);
  });

  it("remoteCleanup: görevin kendi projesi hata verirse yükselir (geçici hata → exit 75 sınıfı)", async () => {
    const id = mkRunning(); setState(id, "cancelled" as any);
    const t: RemoteTransport = { call: async () => { throw new RemoteError("unreachable", "unreachable: windows"); } };
    await expect(remoteCleanup(t, "windows", getTask(id))).rejects.toMatchObject({ transient: true });
  });

  it("markCleaned worktree alanını boşaltır", () => {
    const id = mkRunning();
    markCleaned(id);
    expect(getTask(id).data.worktree).toBeNull();
  });
});
