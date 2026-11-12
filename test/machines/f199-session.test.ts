import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchOp, resumeOp } from "../../src/agent/ops/launch.js";
import { CAPS } from "../../src/agent/ops/ping.js";
import { kbPaths } from "../../src/kb/home.js";
import { defaultConfig } from "../../src/kb/index.js";
import { readSessionFile, sessionName } from "../../src/kb/session.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { RemoteError } from "../../src/machines/index.js";
import type { AgentOp, RemoteTransport } from "../../src/machines/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask } from "../../src/tasks/index.js";
import { launchTask } from "../../src/tasks/launch.js";
import { makeHome, rmTemp } from "../helpers.js";

// F-vlad-199: uzak işçi beyin oturum adını launch/resume ile alır (VLAD_SESSION); ping caps "session" yoksa (eski işçi) alan gönderilmez.
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const ID = "T20261101-61";

let base: string; let home: string; let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(["VLAD_HOME", "VLAD_KB_DIR", "VLAD_MACHINE", "VLAD_CLAUDE_JSON", "VLAD_SESSION"].map((k) => [k, process.env[k]]));
  delete process.env.VLAD_SESSION;
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-f199-")));
  home = makeHome();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmTemp(base); rmTemp(home);
});
const putSession = (name: string) => writeFileSync(join(kbPaths().kb, "vlad-session.txt"), name + "\n");

describe("F-vlad-199 oturum adı çözümü", () => {
  it("VLAD_SESSION dosyadan önce gelir; ikisi de yoksa null", () => {
    expect(sessionName()).toBeNull();
    putSession("vlad-07");
    expect(sessionName()).toBe("vlad-07");
    expect(readSessionFile()).toBe("vlad-07");
    process.env.VLAD_SESSION = "vlad-99";
    expect(sessionName()).toBe("vlad-99");
    expect(readSessionFile()).toBe("vlad-07"); // beyin tarafı yalnız kendi dosyasını okur
  });
  it("ping CAPS 'session' içerir", () => { expect(CAPS).toContain("session"); });
});

describe("F-vlad-199 işçi op'ları", () => {
  let repo: string; let reqs: LaunchRequest[];
  const launcher: Launcher = { launch: async (r) => { reqs.push(r); return { ok: true, method: "fake" }; } };
  const L = (extra: object = {}) => ({ taskId: ID, project: "alpha", repoName: "alpha", branch: `vlad/${ID}`, base: { kind: "default" }, promptTemplate: "g {{TASK_FILE}}", title: "T", ...extra });
  beforeEach(() => {
    const roots = join(base, "roots"); repo = join(roots, "alpha"); mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "f"), "1"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "i");
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, roots: [roots] }] }));
    process.env.VLAD_MACHINE = "windows"; process.env.VLAD_CLAUDE_JSON = join(base, "claude.json");
    reqs = [];
  });
  it("launch: sessionName çalışan ortamına VLAD_SESSION olarak girer; yoksa env'de VLAD_SESSION yok (eski brain)", async () => {
    await launchOp(L({ sessionName: "vlad-07" }), { from: "mac", opId: "o1" }, { launcher });
    expect(reqs[0]!.env).toMatchObject({ VLAD_TASK_ID: ID, VLAD_SESSION: "vlad-07" });
  });
  it("launch: sessionName yok → VLAD_SESSION tanımsız", async () => {
    await launchOp(L(), { from: "mac", opId: "o1" }, { launcher });
    expect(reqs[0]!.env).not.toHaveProperty("VLAD_SESSION");
  });
  it("launch: geçersiz sessionName (boşluk/satır sonu/uzun) reddedilir, hiçbir şey başlamaz", async () => {
    for (const bad of ["a b", "vlad-07\nX=1", "x".repeat(200), "", 5]) {
      await expect(launchOp(L({ sessionName: bad }), { from: "mac", opId: "o2" }, { launcher })).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(reqs).toHaveLength(0);
  });
  it("resume: sessionName VLAD_SESSION olarak geçer", async () => {
    await launchOp(L(), { from: "mac", opId: "o1" }, { launcher });
    await resumeOp({ taskId: ID, project: "alpha", repoName: "alpha", promptTemplate: "r", title: "T", sessionName: "vlad-07" }, { launcher, close: () => [] });
    expect(reqs[1]!.env).toMatchObject({ VLAD_SESSION: "vlad-07" });
  });
});

describe("F-vlad-199 beyin: launchTask uzak yol", () => {
  let repo: string;
  type Handler = (args: any) => unknown;
  function fakeTransport(h: Partial<Record<AgentOp, Handler>>) {
    const calls: { op: AgentOp; args: any }[] = [];
    const t: RemoteTransport = { async call(to, op, args, o) { calls.push({ op, args }); const fn = h[op]; if (!fn) throw new RemoteError("unreachable", "x", to); return { opId: o?.opId ?? "x", result: fn(args) as any }; } };
    return { t, calls, launchArgs: () => calls.find((c) => c.op === "launch")!.args };
  }
  const launched = { branch: "vlad/X", worktree: "W:\\wt\\X", method: "wt" };
  const run = async (f: ReturnType<typeof fakeTransport>) => {
    repo = join(base, "alpha"); mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "a"), "1"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "i");
    const cfg = defaultConfig(); cfg.worktreeDir = join(base, "wt"); cfg.brain = "mac";
    cfg.machines = [{ name: "mac", os: "darwin", agent: { port: 7437 }, maxParallel: 1 }, { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, maxParallel: 1 }];
    writeProject("alpha", `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\nmachines: [windows]\n---\n\n## Özet\nx\n`);
    const task = createTask({ project: "alpha", title: "G", kind: "dev", body: "## Tanım\nx\n" } as any);
    const l: Launcher = { launch: async () => ({ ok: true, method: "fake" }) };
    await launchTask(task.data.id, { launcher: l, cfg, remote: { transport: f.t } });
  };
  it("oturum kaydı var + işçi caps'te session → launch args.sessionName beyin adıdır", async () => {
    putSession("vlad-07");
    const f = fakeTransport({ ping: () => ({ machine: "windows", caps: [...CAPS] }), launch: () => launched });
    await run(f);
    expect(f.launchArgs().sessionName).toBe("vlad-07");
  });
  it.each([["caps yok", { machine: "windows" }], ["session yok", { machine: "windows", caps: ["xfer", "clip"] }]])("eski işçi (%s) → sessionName gönderilmez (strict argObject reddetmesin)", async (_n, ping) => {
    putSession("vlad-07");
    const f = fakeTransport({ ping: () => ping, launch: () => launched });
    await run(f);
    expect(f.launchArgs()).not.toHaveProperty("sessionName");
  });
  it("oturum kaydı yok → sessionName yok", async () => {
    const f = fakeTransport({ ping: () => ({ machine: "windows", caps: [...CAPS] }), launch: () => launched });
    await run(f);
    expect(f.launchArgs()).not.toHaveProperty("sessionName");
  });
});
