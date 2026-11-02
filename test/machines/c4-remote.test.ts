import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { AgentOp, RemoteTransport } from "../../src/machines/index.js";
import { defaultGateTarget, gateMachineOf, recordGreenGate, remoteGateRun, remoteMerge, remoteMergePreview } from "../../src/machines/remote.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, logTask, setState } from "../../src/tasks/index.js";
import { makeHome, rmTemp } from "../helpers.js";

interface Call { to: string; op: AgentOp; args: any; timeoutMs?: number }
const fake = (reply: unknown = {}): RemoteTransport & { calls: Call[] } => {
  const calls: Call[] = [];
  return { calls, async call(to, op, args, o) { calls.push({ to, op, args, timeoutMs: o?.timeoutMs }); return { opId: "o", result: reply as never }; } };
};

const SHA = "a".repeat(40), SHA2 = "b".repeat(40);
let base: string; let home: string;
const card = (slug: string, path: string, extra = "") => writeProject(slug, `---
slug: ${slug}
name: ${slug}
path: ${JSON.stringify(path)}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
${extra}---

## Özet
x
`);
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-c4r-"))); home = makeHome(); card("alpha", join(base, "repos", "alpha"), "default_branch: main\n"); });
afterEach(() => { rmTemp(base); rmTemp(home); });

const cfg: VladConfig = { ...defaultConfig(), brain: "mac" } as VladConfig;
const dev = (extra: Record<string, unknown> = {}, machine: string | null = "windows") => {
  const id = createTask({ project: "alpha", title: "G", kind: "dev", body: "## Tanım\nx\n", ...extra } as any).data.id;
  setState(id, "running", { branch: `vlad/${id}`, worktree: "C:\\wt\\x", ...(machine ? { machine } : {}) } as any);
  return id;
};
const pipeline = () => createTask({ project: "alpha", title: "P", kind: "pipeline", body: "## Tanım\nx\n" } as any).data.id;
const withMachines = { ...cfg, machines: [{ name: "mac" }, { name: "windows" }] } as unknown as VladConfig;

describe("machines:C4 beyin tarafı kapı çağrıları", () => {
  it("gateMachineOf: uzak makinedeki görev → makine; beyin/yerel → null; çatı → uzak çalışan bir fazın makinesi", () => {
    const p = pipeline();
    const f = dev({ parent: p, phase: "uygulama" });
    expect(gateMachineOf(getTask(f), withMachines)).toBe("windows");
    expect(gateMachineOf(getTask(f), cfg)).toBeNull(); // machines tanımsız → yerel
    expect(gateMachineOf(getTask(dev({}, "mac")), withMachines)).toBeNull();
    expect(gateMachineOf(getTask(p), withMachines)).toBe("windows");
    expect(gateMachineOf(getTask(pipeline()), withMachines)).toBeNull();
  });

  it("remoteGateRun: gate-run çağrısı yalnız kimlik/hedef taşır (komut ve yol yok); uzun zaman aşımı", async () => {
    const id = dev();
    const t = fake({ exit: 0, stdout: "ok", stderr: "" });
    const r = await remoteGateRun(t, "windows", getTask(id), "integration");
    expect(r.exit).toBe(0);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ to: "windows", op: "gate-run", args: { taskId: id, project: "alpha", repoName: "alpha", target: "integration" } });
    expect(Object.keys(t.calls[0]!.args).sort()).toEqual(["project", "repoName", "target", "taskId"]);
    expect(t.calls[0]!.timeoutMs).toBeGreaterThan(25 * 60_000);
  });

  it("remoteMergePreview/remoteMerge: faz → vlad/<çatı>; çatısız görev → kartın default_branch'i; --into verilirse o", async () => {
    const p = pipeline();
    const f = dev({ parent: p, phase: "uygulama" });
    const t = fake({ log: "", diffStat: "", conflicts: [], head: "abc", merged: true });
    recordGreenGate(f, { exit: 0, stdout: "", stderr: "", head: SHA }, "task");
    await remoteMergePreview(t, "windows", getTask(f));
    await remoteMerge(t, "windows", getTask(f), { message: "faz kapısı" });
    expect(t.calls[1]!.args.expectHead).toBe(SHA); // aynı sha: akış değişmez, head işçiye karşılaştırma için gider
    expect(t.calls.map((c) => [c.op, c.args.from, c.args.into, c.args.message])).toEqual([
      ["merge-preview", `vlad/${f}`, `vlad/${p}`, undefined],
      ["merge", `vlad/${f}`, `vlad/${p}`, "faz kapısı"],
    ]);
    const solo = dev();
    const t2 = fake({ head: "abc", merged: true });
    recordGreenGate(solo, { exit: 0, stdout: "", stderr: "", head: SHA }, "task");
    await remoteMerge(t2, "windows", getTask(solo));
    expect(t2.calls[0]!.args).toMatchObject({ from: `vlad/${solo}`, into: "main" });
  });

  it("remoteMerge: çatı yok ve kartta default_branch yok → istek gönderilmeden hata", async () => {
    card("beta", join(base, "repos", "beta"));
    const id = createTask({ project: "beta", title: "G", kind: "dev", body: "## Tanım\nx\n" } as any).data.id;
    const t = fake();
    await expect(remoteMerge(t, "windows", getTask(id))).rejects.toThrow(/default_branch/);
    expect(t.calls).toHaveLength(0);
  });

  it("remoteMerge: yeşil gate kaydı yoksa/kırmızıysa/hedefi uyuşmuyorsa istek gitmeden reddedilir; son yeşil kayıt kullanılır", async () => {
    const id = dev();
    const t = fake({ head: "abc", merged: true });
    const no = /yeşil gate kaydı yok/;
    await expect(remoteMerge(t, "windows", getTask(id))).rejects.toThrow(no);
    recordGreenGate(id, { exit: 1, stdout: "", stderr: "", head: SHA }, "task"); // kırmızı kaydedilmez
    await expect(remoteMerge(t, "windows", getTask(id))).rejects.toThrow(no);
    recordGreenGate(id, { exit: 0, stdout: "", stderr: "", head: SHA }, "integration"); // dev görevin dalı için integration gate'i geçersiz
    await expect(remoteMerge(t, "windows", getTask(id))).rejects.toThrow(no);
    expect(t.calls).toHaveLength(0);
    recordGreenGate(id, { exit: 0, stdout: "", stderr: "", head: SHA2 }, "task");
    await remoteMerge(t, "windows", getTask(id));
    expect(t.calls[0]!.args.expectHead).toBe(SHA2);
  });

  it("gate kaydı frontmatter'da; çalışanın İlerleme/rapor metnine yazdığı sahte 'gate yeşil' satırı sayılmaz", async () => {
    const id = dev();
    logTask(id, `gate yeşil: head=${SHA}`);
    const t = fake({ head: "abc", merged: true });
    await expect(remoteMerge(t, "windows", getTask(id))).rejects.toThrow(/yeşil gate kaydı yok/);
  });

  it("çatı: integration gate'i kaydı geçerli, task gate'i geçersiz", async () => {
    const p = pipeline();
    const t = fake({ head: "abc", merged: true });
    recordGreenGate(p, { exit: 0, stdout: "", stderr: "", head: SHA }, "task");
    await expect(remoteMerge(t, "windows", getTask(p))).rejects.toThrow(/yeşil gate kaydı yok/);
    recordGreenGate(p, { exit: 0, stdout: "", stderr: "", head: SHA }, "integration");
    await remoteMerge(t, "windows", getTask(p));
    expect(t.calls[0]!.args.expectHead).toBe(SHA);
  });
  it("bayraksız `task gate` hedefi: dev görev → task (merge reddetmez), çatı → integration", async () => {
    const id = dev();
    const p = pipeline();
    expect(defaultGateTarget(getTask(id))).toBe("task");
    expect(defaultGateTarget(getTask(p))).toBe("integration");
    const t = fake({ head: "abc", merged: true });
    recordGreenGate(id, { exit: 0, stdout: "", stderr: "", head: SHA }, defaultGateTarget(getTask(id)));
    await remoteMerge(t, "windows", getTask(id)); // reddedilmez
    expect(t.calls[0]!.args.expectHead).toBe(SHA);
  });

  it("yeşil gate kaydı yok hatası doğru hedefi söyler", async () => {
    const id = dev();
    const p = pipeline();
    const t = fake({ head: "abc", merged: true });
    await expect(remoteMerge(t, "windows", getTask(id))).rejects.toThrow(/--target task/);
    await expect(remoteMerge(t, "windows", getTask(p))).rejects.toThrow(/--target integration/);
  });
});
