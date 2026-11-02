import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { RemoteError } from "../../src/machines/index.js";
import type { AgentOp, RemoteTransport } from "../../src/machines/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, saveTask, setState } from "../../src/tasks/index.js";
import { launchTask, releaseTask, releaseWarning } from "../../src/tasks/launch.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" });

let repo: string;
let home: string;
let cfg: VladConfig;
beforeEach(() => {
  home = makeHome();
  const base = mkdtempSync(join(tmpdir(), "vlad-f1br-"));
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



const uncertain = () => { throw new RemoteError("timeout", "yanıt yok", "windows"); };

describe("F-vlad-125/142: belirsiz uzak launch rezervasyonu serbest bırakılır", () => {
  async function stuck() {
    card(["windows", "mac"]);
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "## Tanım\np\n" } as any);
    const a = mk({ parent: pipe.data.id, phase: "a" });
    const f = fakeTransport({ ...ok, launch: uncertain });
    await expect(launchTask(a.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow();
    expect(getTask(a.data.id).data.launch_op).toBeTruthy();
    expect(getTask(pipe.data.id).data.machine).toBe("windows"); // F-142: pin kalır
    return { a: a.data.id, pipe: pipe.data.id };
  }

  it("işçi op'u hiç görmediyse (iptal işareti yazılır): rezervasyon ve çatı pin'i kalkar", async () => {
    const { a, pipe } = await stuck();
    const f = fakeTransport({ "op-status": (args) => { expect(args.cancel).toBe(true); return { state: "cancelled" }; } });
    await releaseTask(a, { cfg, transport: f.t });
    expect(getTask(a).data).toMatchObject({ state: "queued", machine: null, machine_reserved: null, launch_op: null });
    expect(getTask(pipe).data.machine ?? null).toBeNull();
  });

  it("işçi launch'ı tamamlamışsa serbest bırakma reddedilir (pencere açık): 'task launch' sahiplenir", async () => {
    const { a } = await stuck();
    const f = fakeTransport({ "op-status": () => ({ state: "done", result: launched }) });
    await expect(releaseTask(a, { cfg, transport: f.t })).rejects.toThrow(/tamamlanmış|task launch/);
    expect(getTask(a).data.launch_op).toBeTruthy();
  });

  it("işçi sürüyor (started) ise reddedilir", async () => {
    const { a } = await stuck();
    const f = fakeTransport({ "op-status": () => ({ state: "started" }) });
    await expect(releaseTask(a, { cfg, transport: f.t })).rejects.toThrow(/sürüyor/);
  });

  it("makineye ulaşılamıyorsa --force olmadan reddedilir; --force ile (kalıcı ölü makine) bırakılır", async () => {
    const { a, pipe } = await stuck();
    const dead = fakeTransport({});
    await expect(releaseTask(a, { cfg, transport: dead.t })).rejects.toThrow(/--force/);
    expect(getTask(a).data.launch_op).toBeTruthy();
    await releaseTask(a, { cfg, transport: dead.t, force: true });
    expect(getTask(a).data).toMatchObject({ machine: null, launch_op: null });
    expect(getTask(pipe).data.machine ?? null).toBeNull();
  });

  describe("F-vlad-150: --force ile bırakılan op işçide başlamış olabilir → released_ops + makine dönünce iptal", () => {
    async function forced() {
      const { a } = await stuck();
      const op = getTask(a).data.launch_op!;
      await releaseTask(a, { cfg, transport: fakeTransport({}).t, force: true });
      return { a, op };
    }

    it("--force bırakması op'u released_ops'ta saklar ve CLI uyarısı yetim riskini yazar; normal bırakma saklamaz", async () => {
      const { a, op } = await forced();
      const t = getTask(a);
      expect(t.data.released_ops).toEqual([{ machine: "windows", op }]);
      expect(releaseWarning(t)).toMatch(/yetim/);
      const { a: b } = await stuck();
      await releaseTask(b, { cfg, transport: fakeTransport({ "op-status": () => ({ state: "cancelled" }) }).t });
      expect(getTask(b).data.released_ops ?? []).toEqual([]);
      expect(releaseWarning(getTask(b))).toBeNull();
    });

    it("makine erişilebilir olunca sonraki launch, launch'tan önce op-status cancel:true gönderir ve kaydı temizler", async () => {
      const { a, op } = await forced();
      const f = fakeTransport({ ...ok, "op-status": () => ({ state: "cancelled" }), launch: () => launched });
      await launchTask(a, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } });
      const cancel = f.calls.findIndex((c) => c.op === "op-status" && c.args.target === op && c.args.cancel === true);
      const launch = f.calls.findIndex((c) => c.op === "launch");
      expect(cancel).toBeGreaterThanOrEqual(0);
      expect(cancel).toBeLessThan(launch);
      expect(getTask(a).data.released_ops ?? []).toEqual([]);
    });

    it("released op iptali başarısız olursa (zaman aşımı/geçici hata) launch durur, kayıt kalır; sonraki denemede yeniden uzlaştırılır", async () => {
      const { a, op } = await forced();
      let fail = true;
      const f = fakeTransport({ ...ok, "op-status": () => { if (fail) throw uncertain(); return { state: "cancelled" }; }, launch: () => launched });
      await expect(launchTask(a, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow(/iptal edilemedi/);
      expect(f.ops("launch")).toHaveLength(0);
      expect(getTask(a).data.released_ops).toEqual([{ machine: "windows", op }]);
      fail = false;
      await launchTask(a, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } });
      expect(f.ops("launch")).toHaveLength(1);
      expect(getTask(a).data.released_ops ?? []).toEqual([]);
    });

    it("işçide bırakılan launch gerçekten başlamışsa yeni launch yapılmaz, yetim worktree'yi söyleyen hata verilir", async () => {
      const { a, op } = await forced();
      const f = fakeTransport({ ...ok, "op-status": () => ({ state: "done", result: launched }), launch: () => launched });
      await expect(launchTask(a, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow(/yetim[\s\S]*W:\\wt\\X/);
      expect(f.ops("launch")).toHaveLength(0);
      expect(getTask(a).data.released_ops ?? []).toEqual([]); // bildirildi; tekrar denemede takılmaz
      expect(op).toBeTruthy();
    });
  });

  it("beyin-yerel rezervasyon (machine = beyin): iptal protokolü çalışmaz, reddedilir, rezervasyon ve pin kalır", async () => {
    card(["mac"]);
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "## Tanım\np\n" } as any);
    const a = mk({ parent: pipe.data.id, phase: "a" });
    const t = getTask(a.data.id);
    Object.assign(t.data, { machine: "mac", machine_reserved: new Date().toISOString(), launch_op: "local-op" });
    saveTask(t);
    const f = fakeTransport({ "op-status": () => ({ state: "cancelled" }) });
    await expect(releaseTask(a.data.id, { cfg, transport: f.t, force: true })).rejects.toThrow(/yerel|beyin/);
    expect(f.calls).toHaveLength(0);
    expect(getTask(a.data.id).data).toMatchObject({ machine: "mac", launch_op: "local-op" });
  });

  it("rezervasyonu olmayan görevde net hata", async () => {
    const t = mk();
    await expect(releaseTask(t.data.id, { cfg, transport: fakeTransport({}).t })).rejects.toThrow(/rezervasyon/);
  });
});

describe("F-vlad-109: launcher beklerken görev cancelled yapılırsa açılan pencere/worktree yetim kalmaz", () => {
  it("cancelled → hata, pencere kapatılır, worktree kaldırılır", async () => {
    const lcfg = { ...cfg, machines: undefined, brain: undefined } as VladConfig;
    const task = mk();
    const closed: string[] = [];
    const launcher: Launcher = { async launch() { setState(task.data.id, "cancelled"); return { ok: true, method: "fake" }; } };
    await expect(launchTask(task.data.id, { launcher, cfg: lcfg, closeWorker: (i) => { closed.push(i); } })).rejects.toThrow(/cancelled/);
    expect(closed).toEqual([task.data.id]);
    expect(existsSync(join(lcfg.worktreeDir, task.data.id))).toBe(false);
    expect(getTask(task.data.id).data.state).toBe("cancelled");
  });
});
