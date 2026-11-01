import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { RemoteError } from "../../src/machines/index.js";
import type { AgentOp, RemoteTransport } from "../../src/machines/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, saveTask, setState } from "../../src/tasks/index.js";
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

describe("machines:C1 launchTask — yerleştirme + uzak yol", () => {
  it("kart [windows]: uzak launch; yerel launcher çağrılmaz; görev running + machine, rezervasyon temizlenir", async () => {
    const task = mk();
    const l = fakeLauncher();
    const f = fakeTransport({
      ...ok,
      launch: (a, opId) => {
        const mid = getTask(task.data.id).data; // çağrı sırasında rezervasyon görünür, görev hâlâ queued
        expect(mid).toMatchObject({ state: "queued", machine: "windows", launch_op: opId });
        expect(mid.machine_reserved).toBeTruthy();
        return { ...launched, branch: a.branch };
      },
    });
    const r = await launchTask(task.data.id, { launcher: l, cfg, remote: { transport: f.t } });
    expect(l.reqs).toHaveLength(0);
    expect(r.data).toMatchObject({ state: "running", machine: "windows", machine_reserved: null, launch_op: null, error: null, worktree: "W:\\wt\\X" });
    const a = f.ops("launch")[0].args;
    expect(a).toMatchObject({ taskId: task.data.id, project: "alpha", repoName: "alpha", branch: `vlad/${task.data.id}`, base: { kind: "default" } });
    expect(a.promptTemplate).toContain("{{TASK_FILE}}");
    expect(a.promptTemplate).not.toContain(home);
  });

  it("kart brain'e düşerse yerel yol: launcher çağrılır, machine=brain yazılır, ağ yok", async () => {
    card(undefined);
    const task = mk();
    const l = fakeLauncher();
    const f = fakeTransport(ok);
    const r = await launchTask(task.data.id, { launcher: l, cfg, remote: { transport: f.t } });
    expect(l.reqs).toHaveLength(1);
    expect(r.data).toMatchObject({ state: "running", machine: "mac" });
    expect(f.calls).toHaveLength(0);
  });

  it("machines yoksa görev alanlarına machine yazılmaz (eski davranış)", async () => {
    const c2 = defaultConfig();
    c2.worktreeDir = cfg.worktreeDir;
    card(undefined);
    const task = mk();
    const r = await launchTask(task.data.id, { launcher: fakeLauncher(), cfg: c2 });
    expect(r.data.machine).toBeUndefined();
    expect(r.data.launch_op).toBeUndefined();
  });

  it("aday dolu: hata, ağ yok; ilk aday erişilemezse sıradaki seçilir", async () => {
    card(["windows", "mac"]);
    const fill = mk();
    setState(fill.data.id, "running", { machine: "windows" });
    const task = mk();
    const l = fakeLauncher();
    // windows dolu (ping yok), mac boş -> yerel
    const f = fakeTransport(ok);
    const r = await launchTask(task.data.id, { launcher: l, cfg, remote: { transport: f.t } });
    expect(r.data.machine).toBe("mac");
    expect(f.calls).toHaveLength(0);
  });

  it("tek aday dolu: 'bekliyor' hatası, görev queued, rezervasyon yok", async () => {
    const fill = mk();
    setState(fill.data.id, "running", { machine: "windows" });
    const task = mk();
    const f = fakeTransport(ok);
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow(/windows: dolu/);
    expect(f.calls).toHaveLength(0);
    expect(getTask(task.data.id).data).toMatchObject({ state: "queued" });
    expect(getTask(task.data.id).data.machine ?? null).toBeNull();
  });

  it("aday erişilemez: neden 'erişilemez', sıradaki aday seçilir", async () => {
    card(["windows", "mac"]);
    const task = mk();
    const f = fakeTransport({ ping: () => { throw new RemoteError("timeout", "zaman aşımı", "windows"); } });
    const r = await launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } });
    expect(r.data.machine).toBe("mac");
    expect(f.ops("ping")).toHaveLength(1);
  });

  it("--machine: kart listesinde olmayan ad reddedilir; olan ad sabitlenir", async () => {
    card(["windows", "mac"]);
    const task = mk();
    const f = fakeTransport({ ...ok, launch: (a) => ({ ...launched, branch: a.branch }) });
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t }, machine: "baska" })).rejects.toThrow("--machine kart listesinde yok: baska");
    const r = await launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t }, machine: "windows" });
    expect(r.data.machine).toBe("windows");
  });

  it("kesin hata (failed): rezervasyon temizlenir, hata kaydedilir, görev queued", async () => {
    const task = mk();
    const f = fakeTransport({ ...ok, launch: () => { throw new RemoteError("failed", "repo yok: alpha", "windows"); } });
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow("repo yok: alpha");
    const d = getTask(task.data.id).data;
    expect(d).toMatchObject({ state: "queued", machine_reserved: null, launch_op: null });
    expect(d.error).toContain("repo yok: alpha");
  });

  it("belirsiz sonuç (timeout): rezervasyon KALIR, durum queued, hata geçici", async () => {
    const task = mk();
    const f = fakeTransport({ ...ok, launch: () => { throw new RemoteError("timeout", "yanıt gelmedi", "windows"); } });
    const err = await launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } }).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.transient).toBe(true);
    const d = getTask(task.data.id).data;
    expect(d).toMatchObject({ state: "queued", machine: "windows" });
    expect(d.launch_op).toBe(f.ops("launch")[0].opId);
    expect(d.machine_reserved).toBeTruthy();
  });

  it("sonraki launch: op-status 'done' -> sahiplen (adopt), yeniden launch yok", async () => {
    const task = mk();
    const t = getTask(task.data.id);
    Object.assign(t.data, { machine: "windows", launch_op: "op-eski", machine_reserved: new Date().toISOString() });
    saveTask(t);
    const f = fakeTransport({ ...ok, "op-status": () => ({ state: "done", result: { ...launched, branch: `vlad/${task.data.id}` } }) });
    const r = await launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } });
    expect(f.ops("op-status")[0].args).toEqual({ target: "op-eski" });
    expect(f.ops("launch")).toHaveLength(0);
    expect(r.data).toMatchObject({ state: "running", machine: "windows", launch_op: null, machine_reserved: null, worktree: "W:\\wt\\X" });
  });

  it("op-status 'started': bekle (hata), hiçbir şey değişmez", async () => {
    const task = mk();
    const t = getTask(task.data.id);
    Object.assign(t.data, { machine: "windows", launch_op: "op-eski", machine_reserved: new Date().toISOString() });
    saveTask(t);
    const f = fakeTransport({ ...ok, "op-status": () => ({ state: "started" }) });
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow(/sürüyor/);
    expect(getTask(task.data.id).data).toMatchObject({ state: "queued", launch_op: "op-eski" });
  });

  it("op-status 'unknown': önce cancel (tombstone), sonra YENİ launch_op ile yeniden dener", async () => {
    const task = mk();
    const t = getTask(task.data.id);
    Object.assign(t.data, { machine: "windows", launch_op: "op-eski", machine_reserved: new Date().toISOString() });
    saveTask(t);
    const f = fakeTransport({
      ...ok,
      "op-status": () => ({ state: "unknown" }),
      launch: (a) => ({ ...launched, branch: a.branch }),
    });
    const r = await launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } });
    const st = f.ops("op-status");
    expect(st[0].args).toEqual({ target: "op-eski" });
    expect(st.some((c) => c.args.cancel === true && c.args.target === "op-eski")).toBe(true);
    const order = f.calls.map((c) => c.op);
    expect(order.indexOf("launch")).toBeGreaterThan(order.lastIndexOf("op-status"));
    expect(f.ops("launch")[0].opId).not.toBe("op-eski");
    expect(r.data.state).toBe("running");
  });

  it("geç yanıt: bu arada başka deneme launch_op'u değiştirdiyse yazılmaz, yeni rezervasyon silinmez", async () => {
    const task = mk();
    const f = fakeTransport({
      ...ok,
      launch: (a) => {
        const t = getTask(task.data.id);
        t.data.launch_op = "op-yeni";
        saveTask(t);
        return { ...launched, branch: a.branch };
      },
    });
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow(/başka deneme/);
    expect(getTask(task.data.id).data).toMatchObject({ state: "queued", launch_op: "op-yeni", machine: "windows" });
  });

  it("kb eşitleme kancası launch'tan ÖNCE çalışır; reddederse launch yok ve rezervasyon temizlenir", async () => {
    const task = mk();
    const order: string[] = [];
    const f = fakeTransport({ ...ok, launch: (a) => { order.push("launch"); return { ...launched, branch: a.branch }; } });
    await launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t, syncKb: async () => { order.push("sync"); } } });
    expect(order).toEqual(["sync", "launch"]);

    const t2 = mk();
    const f2 = fakeTransport({ ...ok, launch: () => ({ ...launched }) });
    await expect(launchTask(t2.data.id, { launcher: fakeLauncher(), cfg: { ...cfg, machines: cfg.machines!.map((m) => ({ ...m, maxParallel: 5 })) }, remote: { transport: f2.t, syncKb: async () => { throw new Error("kb push edilmedi"); } } })).rejects.toThrow("kb push edilmedi");
    expect(f2.ops("launch")).toHaveLength(0);
    expect(getTask(t2.data.id).data).toMatchObject({ state: "queued", machine_reserved: null, launch_op: null });
  });

  it("pipeline: ilk fazın makinesi çatıya yazılır; sonraki faz yalnız o makineye gider", async () => {
    card(["mac", "windows"]);
    const fill = mk();
    setState(fill.data.id, "running", { machine: "mac" });
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "## Tanım\np\n" } as any);
    const p1 = mk({ parent: pipe.data.id, phase: "a" });
    const f = fakeTransport({ ...ok, launch: (a) => ({ ...launched, branch: a.branch, integration: { branch: `vlad/${pipe.data.id}`, worktree: "W:\\wt\\P" } }) });
    const r1 = await launchTask(p1.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } });
    expect(r1.data.machine).toBe("windows");
    expect(getTask(pipe.data.id).data.machine).toBe("windows");
    expect(f.ops("launch")[0].args.base).toMatchObject({ kind: "integration", parent: pipe.data.id });
    expect(getTask(pipe.data.id).data).toMatchObject({ branch: `vlad/${pipe.data.id}`, worktree: "W:\\wt\\P" });
    // mac boşalsın, windows dolu kalsın: ikinci faz mac'e kaymaz
    setState(fill.data.id, "cancelled");
    const p2 = mk({ parent: pipe.data.id, phase: "b" });
    await expect(launchTask(p2.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow(/windows: dolu/);
  });

  it("uzak makine seçildi ama taşıma yok: açık hata, rezervasyon yazılmaz", async () => {
    const task = mk();
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg })).rejects.toThrow(/uzak taşıma/);
    expect(getTask(task.data.id).data.launch_op ?? null).toBeNull();
  });

  it("geç yanıt eski denemenin hatasıyla yeni denemenin görevine hata yazmaz", async () => {
    const task = mk();
    const f = fakeTransport({
      ...ok,
      launch: () => {
        const x = getTask(task.data.id);
        x.data.launch_op = "op-yeni";
        saveTask(x);
        throw new RemoteError("failed", "eski hata", "windows");
      },
    });
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow("eski hata");
    const d = getTask(task.data.id).data;
    expect(d.launch_op).toBe("op-yeni");
    expect(d.error ?? null).toBeNull();
  });

  it("uzak launch başarılı ama kayıt yazılamazsa rezervasyon KALIR (sonraki launch op-status ile sahiplenir)", async () => {
    const task = mk();
    const f = fakeTransport({ ...ok, launch: () => ({ branch: "vlad/X", worktree: 5 }) }); // worktree string değil: şema yazmayı reddeder
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow();
    const d = getTask(task.data.id).data;
    expect(d).toMatchObject({ state: "queued", machine: "windows" });
    expect(d.launch_op).toBeTruthy();
  });

  it("rol dosyası yoksa rezervasyon yazılmaz", async () => {
    const task = mk();
    const rt = getTask(task.data.id);
    rt.data.role = "yok-boyle-rol";
    saveTask(rt);
    const f = fakeTransport(ok);
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow();
    expect(getTask(task.data.id).data.launch_op ?? null).toBeNull();
  });

  it("op-status 'done' ama sonuç yok: hata, yeniden launch yok", async () => {
    const task = mk();
    const t = getTask(task.data.id);
    Object.assign(t.data, { machine: "windows", launch_op: "op-eski", machine_reserved: new Date().toISOString() });
    saveTask(t);
    const f = fakeTransport({ ...ok, "op-status": () => ({ state: "done" }), launch: () => launched });
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg, remote: { transport: f.t } })).rejects.toThrow(/sonuç yok/);
    expect(f.ops("launch")).toHaveLength(0);
  });

  it("machines yokken --machine açık hata verir", async () => {
    const c2 = defaultConfig();
    c2.worktreeDir = cfg.worktreeDir;
    card(undefined);
    const task = mk();
    await expect(launchTask(task.data.id, { launcher: fakeLauncher(), cfg: c2, machine: "windows" })).rejects.toThrow(/yalnız config'te machines/);
  });
});
