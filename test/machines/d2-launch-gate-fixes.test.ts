import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { RemoteError } from "../../src/machines/index.js";
import type { AgentOp, RemoteTransport } from "../../src/machines/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, setState } from "../../src/tasks/index.js";
import { launchTask } from "../../src/tasks/launch.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" });

let repo: string;
let home: string;
let cfg: VladConfig;
beforeEach(() => {
  home = makeHome();
  const base = mkdtempSync(join(tmpdir(), "vlad-c1l-"));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  cfg = defaultConfig();
  cfg.worktreeDir = join(base, "wt");
  cfg.brain = "mac";
  cfg.machines = [
    { name: "mac", os: "darwin", agent: { port: 7437 }, maxParallel: 1 },
    { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, maxParallel: 1 },
  ];
  card(["windows"]);
});
afterEach(() => { rmTemp(dirname(repo)); rmTemp(home); });

function card(machines?: string[]) {
  writeProject("alpha", `---
slug: alpha
name: Alpha
path: ${JSON.stringify(repo)}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
${machines ? `machines: [${machines.join(", ")}]\n` : ""}---

## Özet
x
`);
}
const fakeLauncher = (): Launcher & { reqs: LaunchRequest[] } => {
  const reqs: LaunchRequest[] = [];
  return { reqs, async launch(r) { reqs.push(r); return { ok: true, method: "fake" }; } };
};
const mk = (extra: Record<string, unknown> = {}) => createTask({ project: "alpha", title: "G", kind: "dev", body: "## Tanım\nx\n", ...extra } as any);

type Handler = (args: any, opId: string | undefined) => unknown | Promise<unknown>;
function fakeTransport(h: Partial<Record<AgentOp, Handler>>) {
  const calls: { to: string; op: AgentOp; args: any; opId?: string }[] = [];
  const t: RemoteTransport = {
    async call(to, op, args, o) {
      calls.push({ to, op, args, opId: o?.opId });
      const fn = h[op];
      if (!fn) throw new RemoteError("unreachable", "bağlanamadı", to);
      return { opId: o?.opId ?? "x", result: (await fn(args, o?.opId)) as any };
    },
  };
  return { t, calls, ops: (op: AgentOp) => calls.filter((c) => c.op === op) };
}
const ok = { ping: () => ({ machine: "windows" }) };
const launched = { branch: "vlad/X", worktree: "W:\\wt\\X", method: "wt" };


describe("son kapı düzeltmeleri — launch", () => {
  it("P1-2: otomatik yerleştirme uzak makine seçerse --external/--dry-run net hata verir, uzakta launch yok", async () => {
    for (const flag of [{ external: true }, { dryRun: true }]) {
      const task = mk();
      const f = fakeTransport({ ...ok, launch: () => launched });
      await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t }, ...flag })).rejects.toThrow(/uzak makinede desteklenmez/);
      expect(f.ops("launch")).toHaveLength(0);
      expect(getTask(task.data.id).data).toMatchObject({ state: "queued" });
      expect(getTask(task.data.id).data.launch_op ?? null).toBeNull();
    }
  });

  it("P1-3: sabitlenmemiş pipeline'ın iki fazı aynı anda farklı makinelere gitmez; çatı ilk rezervasyonla sabitlenir", async () => {
    card(["windows", "mac"]);
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "## Tanım\np\n" } as any);
    const a = mk({ parent: pipe.data.id, phase: "a" });
    const b = mk({ parent: pipe.data.id, phase: "b" });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = fakeTransport({ ...ok, launch: async (x) => { await gate; return { ...launched, branch: x.branch, integration: { branch: `vlad/${pipe.data.id}`, worktree: "W:\\wt\\P" } }; } });
    const l = fakeLauncher();
    const pa = launchTask(a.data.id, { launcher: l, cfg, remote: { transport: f.t } });
    await vi.waitFor(() => expect(f.ops("launch")).toHaveLength(1)); // A windows'ta rezerve, uzak launch sürüyor
    expect(getTask(pipe.data.id).data.machine).toBe("windows");
    await expect(launchTask(b.data.id, { launcher: l, cfg, remote: { transport: f.t } })).rejects.toThrow(/windows/);
    release();
    await pa;
    expect(l.reqs).toHaveLength(0);
    expect(getTask(b.data.id).data.state).toBe("queued");
    expect(getTask(pipe.data.id).data.machine).toBe("windows");
  });

  it("P1-3: ilk faz uzakta kesin başarısız olursa çatı pin'i temizlenir", async () => {
    card(["windows", "mac"]);
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "## Tanım\np\n" } as any);
    const a = mk({ parent: pipe.data.id, phase: "a" });
    const f = fakeTransport({ ...ok, launch: () => { throw new RemoteError("failed", "pencere açılamadı", "windows"); } });
    await expect(launchTask(a.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow("pencere açılamadı");
    expect(getTask(pipe.data.id).data.machine ?? null).toBeNull();
  });

  it("P2-5: uzak istem rol dosyası ve vendored skill yolunu beynin yolu olarak taşımaz (yer tutucu)", async () => {
    mkdirSync(join(home, "roles"), { recursive: true });
    copyFileSync(join(process.cwd(), "roles", "developer.md"), join(home, "roles", "developer.md"));
    const task = mk({ role: "developer" });
    const f = fakeTransport({ ...ok, launch: () => launched });
    await launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } });
    const t = f.ops("launch")[0].args.promptTemplate as string;
    expect(t).toContain("{{ROLE_FILE:developer}}");
    expect(t).toContain("{{VENDOR_SKILL:ponytail}}");
    expect(t).not.toContain(home);
  });
});
