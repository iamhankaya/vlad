// K1, K2, K3, K16 — yerleştirme (kabul kriteri 1) ve pipeline sabitleme. Kaynak: plan "Kapasite, yerleştirme, pipeline" + KABUL kriterleri.
// Kırmızı başlar (fazlar A/C1 gelmeden). Duvar saati eşiği yok; sayaç + NOOP_LOG.
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startProxy, type Proxy } from "../machines/harness.js";
import { front, makeWorld, runVlad, type World } from "./machines-world.js";

let w: World | undefined;
const proxies: Proxy[] = [];
afterEach(async () => {
  for (const p of proxies.splice(0)) await p.stop();
  await w?.cleanup();
  w = undefined;
});

const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
const idOf = (x: any): string => (typeof x === "string" ? x : x.id ?? x.data?.id);
const heldIds = (j: any): string[] => (j.held_by_limit ?? []).map(idOf);
const readyJson = async (world: World) => {
  const r = await runVlad(world.brain, ["task", "ready", "--json"]);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out);
};
/** mac üzerinde çalışan (kapasiteyi dolduran) dev görevi */
const fillMachine = async (world: World, machine: string) => {
  const id = await world.newTask();
  world.setFront(id, { state: "running", machine });
  return id;
};

describe("machines:K — kart machines alanı (project set)", () => {
  it("project set machines 'mac,windows' kartı günceller; config'te olmayan ad reddedilir", async () => {
    w = await makeWorld();
    const ok = await runVlad(w.brain, ["project", "set", w.slug, "machines", "mac,windows"]);
    expect(ok.code, ok.err).toBe(0);
    const bad = await runVlad(w.brain, ["project", "set", w.slug, "machines", "mac,yok-boyle-makine"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("config'te tanımlı değil: yok-boyle-makine");
    const list = JSON.parse((await runVlad(w.brain, ["project", "list", "--json"])).out);
    expect(JSON.stringify(list)).toContain("windows");
  }, 60_000);
});

describe("machines:K — K1 Mac doluyken [mac,windows] projesi Windows'a", () => {
  it("windows'ta tam 1 launch, mac'te 0; görev machine=windows", async () => {
    w = await makeWorld({ cardMachines: ["mac", "windows"] });
    await w.startAgents(["worker"]);
    await fillMachine(w, "mac");
    const id = await w.newTask();
    const before = w.noop(w.brain).length;
    const r = await runVlad(w.brain, ["task", "launch", id, "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(w.noop(w.worker).filter((l) => l.taskId === id)).toHaveLength(1);
    expect(w.noop(w.brain)).toHaveLength(before); // mac'te yeni başlatma yok
    expect(front(w.readTask(w.brain, id), "machine")).toBe("windows");
    expect(front(w.readTask(w.brain, id), "state")).toBe("running");
  }, 60_000);

  it("mac boşken tercih sırası: ilk makine (mac) seçilir, windows'a dokunulmaz", async () => {
    w = await makeWorld({ cardMachines: ["mac", "windows"] });
    await w.startAgents(["worker"]);
    const px = await startProxy({ port: w.agents.worker!.port });
    proxies.push(px);
    w.setPorts({ windows: px.port });
    const id = await w.newTask();
    const r = await runVlad(w.brain, ["task", "launch", id, "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(w.noop(w.brain).filter((l) => l.taskId === id)).toHaveLength(1);
    expect(w.noop(w.worker)).toHaveLength(0);
    expect(px.count).toBe(0); // boş ilk aday bulunduktan sonra sonrakine ping yok
  }, 60_000);
});

describe("machines:K — K2 [windows] projesi asla Mac'te başlamaz", () => {
  it("windows dolu: held_by_limit 'dolu', mac'te 0 başlatma, dolu aday için ping yok", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    const px = await startProxy({ port: w.agents.worker!.port });
    proxies.push(px);
    w.setPorts({ windows: px.port });
    await fillMachine(w, "windows");
    const id = await w.newTask();
    const j = await readyJson(w);
    expect(heldIds(j)).toContain(id);
    expect(JSON.stringify((j.held_reasons as any[]).find((x) => idOf(x) === id))).toContain("dolu"); // neden held_reasons'ta (cli.ts:495), görev kaydında değil
    const r = await runVlad(w.brain, ["task", "launch", id, "--json"]);
    expect(r.code).not.toBe(0);
    expect(w.noop(w.brain)).toHaveLength(0);
    expect(w.noop(w.worker)).toHaveLength(0);
    expect(front(w.readTask(w.brain, id), "state")).toBe("queued");
    expect(px.count).toBe(0);
  }, 60_000);

  it("her iki makine de dolu olsa bile [windows] kartı mac boşken mac'e düşmez", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    await fillMachine(w, "windows"); // mac boş
    const id = await w.newTask();
    const r = await runVlad(w.brain, ["task", "launch", id]);
    expect(r.code).not.toBe(0);
    expect(w.noop(w.brain)).toHaveLength(0);
  }, 60_000);
});

describe("machines:K — K3 erişilemeyen makine yerleştirmede atlanır", () => {
  // Karar (VLAD, A fazı sapması): `task ready` bilinçli olarak ağsız önizlemedir; erişilemezlik `task launch` içindeki pickMachine/ping'de tutar.
  it("[windows], agent yok: ready ağsız önizleme (ping yok); launch 'erişilemez' ile reddeder, tek ping, pencere yok", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    const px = await startProxy({ port: await freePort() }); // hedef dinlemiyor
    proxies.push(px);
    w.setPorts({ windows: px.port });
    const id = await w.newTask();
    const j = await readyJson(w);
    expect(JSON.stringify(j.tasks)).toContain(id); // ağsız önizleme: erişilebilirlik sorulmaz
    expect(px.count).toBe(0);
    const r = await runVlad(w.brain, ["task", "launch", id]);
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toContain("erişilemez");
    expect(px.count).toBe(1);
    expect(front(w.readTask(w.brain, id), "state")).toBe("queued");
    expect(w.noop(w.brain)).toHaveLength(0);
  }, 60_000);

  it("[mac,windows], mac dolu + windows erişilemez: launch reddedilir; geri gelince (agent açılınca) yerleşir", async () => {
    w = await makeWorld({ cardMachines: ["mac", "windows"] });
    await fillMachine(w, "mac");
    const dead = await freePort();
    w.setPorts({ windows: dead });
    const id = await w.newTask();
    const held = await runVlad(w.brain, ["task", "launch", id]);
    expect(held.code).not.toBe(0);
    expect(held.err + held.out).toContain("erişilemez");
    expect(front(w.readTask(w.brain, id), "state")).toBe("queued");
    await w.startAgents(["worker"]); // aynı config'e gerçek port yazılır
    expect((await runVlad(w.brain, ["task", "launch", id, "--json"])).code).toBe(0);
    expect(w.noop(w.worker).map((l) => l.taskId)).toContain(id);
  }, 60_000);
});

describe("machines:K — K16 pipeline ilk fazın makinesine sabitlenir", () => {
  const phase = async (world: World, parent: string, name: string, dep?: string) =>
    world.newTask({ args: ["--parent", parent, "--phase", name, ...(dep ? ["--depends-on", dep] : [])] });

  it("çatıya ilk fazın makinesi yazılır; sonraki faz mac boşken de windows'a gider", async () => {
    w = await makeWorld({ cardMachines: ["mac", "windows"] });
    await w.startAgents(["worker"]);
    const pr = await runVlad(w.brain, ["task", "new", "--project", w.slug, "--title", "P", "--kind", "pipeline", "--body-file", "-", "--json"], { stdin: "## Tanım\np\n" });
    expect(pr.code, pr.err).toBe(0);
    const pid = JSON.parse(pr.out).id as string;
    const f1 = await phase(w, pid, "uygulama");
    const f2 = await phase(w, pid, "doğrulama", f1);
    const filler = await fillMachine(w, "mac"); // mac dolu → f1 windows'a
    expect((await runVlad(w.brain, ["task", "launch", f1, "--json"])).code).toBe(0);
    expect(front(w.readTask(w.brain, f1), "machine")).toBe("windows");
    expect(front(w.readTask(w.brain, pid), "machine")).toBe("windows"); // çatıya yazıldı
    // mac artık boş; f1 bitti
    w.setFront(filler, { state: "done" });
    w.setFront(f1, { state: "done" });
    const before = w.noop(w.brain).length;
    expect((await runVlad(w.brain, ["task", "launch", f2, "--json"])).code).toBe(0);
    expect(front(w.readTask(w.brain, f2), "machine")).toBe("windows");
    expect(w.noop(w.brain)).toHaveLength(before);
    expect(w.noop(w.worker).map((l) => l.taskId)).toEqual([f1, f2]);
  }, 90_000);

  it("pipeline makinesi doluysa sonraki faz başka makineye kaymaz, held_by_limit", async () => {
    w = await makeWorld({ cardMachines: ["mac", "windows"] });
    await w.startAgents(["worker"]);
    const pr = await runVlad(w.brain, ["task", "new", "--project", w.slug, "--title", "P", "--kind", "pipeline", "--body-file", "-", "--json"], { stdin: "## Tanım\np\n" });
    const pid = JSON.parse(pr.out).id as string;
    const f1 = await phase(w, pid, "uygulama");
    const f2 = await phase(w, pid, "doğrulama");
    await fillMachine(w, "mac");
    expect((await runVlad(w.brain, ["task", "launch", f1])).code).toBe(0); // windows
    // windows dolu (f1 running, cap 1), mac boşalır
    const macFill = (await w.list()).find((t) => t.machine === "mac" && t.state === "running")!;
    w.setFront(macFill.id, { state: "done" });
    expect((await runVlad(w.brain, ["task", "launch", f2])).code).not.toBe(0);
    expect(w.noop(w.brain)).toHaveLength(0);
    expect(heldIds(await readyJson(w))).toContain(f2);
  }, 90_000);
});
