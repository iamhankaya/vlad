import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, saveTask } from "../../src/tasks/index.js";
import { repinPipeline } from "../../src/tasks/launch.js";
import { makeHome, rmTemp } from "../helpers.js";

let base: string;
let home: string;
let cfg: VladConfig;
beforeEach(() => {
  home = makeHome();
  base = mkdtempSync(join(tmpdir(), "vlad-repin-"));
  const repo = join(base, "alpha");
  mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "1");
  cfg = defaultConfig();
  cfg.brain = "mac";
  cfg.machines = [
    { name: "mac", os: "darwin", agent: { port: 7437 }, maxParallel: 1 },
    { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, maxParallel: 1 },
  ];
  card(repo, ["mac", "windows"]);
});
afterEach(() => { rmTemp(base); rmTemp(home); });

function card(repo: string, machines: string[]) {
  writeProject("alpha", `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\nmachines: [${machines.join(", ")}]\n---\n\n## Özet\nx\n`);
}
const pipeline = (machine: string | null) => {
  const p = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "## Tanım\nx\n" } as any);
  const t = getTask(p.data.id);
  t.data.machine = machine;
  saveTask(t);
  return p.data.id;
};
const phase = (parent: string, over: Record<string, unknown>) => {
  const c = createTask({ project: "alpha", title: "F", kind: "dev", parent, body: "## Tanım\nx\n" } as any);
  const t = getTask(c.data.id);
  Object.assign(t.data, over);
  saveTask(t);
  return c.data.id;
};

describe("task repin", () => {
  it("çatı pin'ini hedef makineye taşır, İlerleme'ye Repin satırı yazar, entegrasyon dalı uyarısı verir", async () => {
    const id = pipeline("windows");
    const r = await repinPipeline(id, "mac", { cfg });
    expect(getTask(id).data.machine).toBe("mac");
    expect(getTask(id).body).toMatch(/Repin: windows → mac/);
    expect(r.from).toBe("windows");
    expect(r.warnings.join(" ")).toMatch(/entegrasyon/);
  });
  it("pipeline olmayan görevi reddeder", async () => {
    const t = createTask({ project: "alpha", title: "D", kind: "dev", body: "## Tanım\nx\n" } as any);
    await expect(repinPipeline(t.data.id, "mac", { cfg })).rejects.toThrow(/pipeline/);
  });
  it("kart listesinde olmayan makineyi reddeder", async () => {
    const id = pipeline("windows");
    card(join(base, "alpha"), ["windows"]);
    await expect(repinPipeline(id, "mac", { cfg })).rejects.toThrow(/kart/);
    expect(getTask(id).data.machine).toBe("windows");
  });
  it("config'te olmayan makineyi reddeder", async () => {
    const id = pipeline("windows");
    await expect(repinPipeline(id, "linux", { cfg })).rejects.toThrow(/config/);
  });
  it("eski makinede running faz varsa reddeder; --force uyarıyla taşır", async () => {
    const id = pipeline("windows");
    phase(id, { state: "running", machine: "windows" });
    await expect(repinPipeline(id, "mac", { cfg })).rejects.toThrow(/running/);
    expect(getTask(id).data.machine).toBe("windows");
    const r = await repinPipeline(id, "mac", { cfg, force: true });
    expect(getTask(id).data.machine).toBe("mac");
    expect(r.warnings.join(" ")).toMatch(/running/);
  });
  it("eski makinede onay bekleyen faz da engeller", async () => {
    const id = pipeline("windows");
    phase(id, { state: "awaiting_approval", machine: "windows" });
    await expect(repinPipeline(id, "mac", { cfg })).rejects.toThrow(/awaiting_approval/);
  });
  it("--force queued rezervasyonu released_ops'a yazıp temizler", async () => {
    const id = pipeline("windows");
    const ph = phase(id, { state: "queued", machine: "windows", launch_op: "op1" });
    await expect(repinPipeline(id, "mac", { cfg })).rejects.toThrow(/windows/);
    await repinPipeline(id, "mac", { cfg, force: true });
    const t = getTask(ph);
    expect(t.data.launch_op).toBeNull();
    expect(t.data.machine).toBeNull();
    expect(t.data.released_ops).toEqual([{ machine: "windows", op: "op1" }]);
  });
  it("aynı makineye taşımayı reddeder", async () => {
    const id = pipeline("mac");
    await expect(repinPipeline(id, "mac", { cfg })).rejects.toThrow(/zaten/);
  });
  it("machines tanımsızken reddeder", async () => {
    const id = pipeline("windows");
    await expect(repinPipeline(id, "mac", { cfg: defaultConfig() })).rejects.toThrow(/machines/);
  });
});
