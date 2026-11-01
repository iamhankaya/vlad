// K11 uzak stalled (ağsız yollar sayaçla), K12 eşzamanlılık + rezervasyon + belirsiz launch, K14 kb-sync (gerçek git klonları).
// Duvar saati eşiği yok: süreler `now ± dakika` fixture'ı; sayaç = vekil bağlantı sayısı; çift pencere = NOOP_LOG.
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startAgent, startProxy, type Proxy } from "../machines/harness.js";
import { front, git, makeWorld, runVlad, type World } from "./machines-world.js";
import { rawCall, pairKey } from "./machines-raw.js";

let w: World | undefined;
const proxies: Proxy[] = [];
afterEach(async () => { for (const p of proxies.splice(0)) await p.stop(); await w?.cleanup(); w = undefined; });
const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
const resp = (o: Awaited<ReturnType<typeof rawCall>>) => { expect(o.kind).toBe("response"); return (o as any).resp; };
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const isNull = (v: string | undefined) => v === undefined || v === "null" || v === "~" || v === "";

describe("machines:K — K11 uzak stalled", () => {
  /** windows'ta çalışıyor görünen, uzun süredir sessiz görev */
  const silentTask = async (world: World, idleMin: number) => {
    const id = await world.newTask();
    world.setFront(id, { state: "running", machine: "windows", worktree: join(world.base, "orada", id), branch: `vlad/${id}`, updated: minsAgo(idleMin) });
    return id;
  };

  it("windows kapalı: --no-mark ve --hook yollarında SIFIR bağlantı; mark yolunda makine başına tam 1; running→stalled + 'makine erişilemiyor: windows'", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    const px = await startProxy({ port: await freePort() }); // hedef kapalı; her bağlantı sayılır
    proxies.push(px);
    w.setPorts({ windows: px.port });
    const id = await silentTask(w, 120);
    expect((await runVlad(w.brain, ["status", "--no-mark", "--json"])).code).toBe(0);
    expect(px.count).toBe(0);
    expect((await runVlad(w.brain, ["status", "--summary", "--hook"])).code).toBe(0);
    expect(px.count).toBe(0);
    expect(front(w.readTask(w.brain, id), "state")).toBe("running");
    const r = await runVlad(w.brain, ["status", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(px.count).toBe(1);
    const t = w.readTask(w.brain, id);
    expect(front(t, "state")).toBe("stalled");
    expect(t).toContain("makine erişilemiyor: windows");
  }, 60_000);

  it("windows kapalı ama görev yeni güncellendi (sessizlik eşiği dolmadı): stalled işaretlenmez", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    w.setPorts({ windows: await freePort() });
    const id = await silentTask(w, 1);
    await runVlad(w.brain, ["status", "--json"]);
    expect(front(w.readTask(w.brain, id), "state")).toBe("running");
  }, 60_000);

  it("işçi saati +10 dk kaymış: yeni güncellenmiş görev yanlışlıkla stalled olmaz (mutlak zaman taşınmaz)", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    const nowFile = join(w.base, "now.txt");
    writeFileSync(nowFile, String(Date.now() + 10 * 60_000));
    w.writeConfig();
    w.agents.worker = await startAgent(w.worker, { nowFile });
    w.setPorts({ windows: w.agents.worker.port });
    const id = await silentTask(w, 1);
    const r = await runVlad(w.brain, ["status", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(front(w.readTask(w.brain, id), "state")).toBe("running");
  }, 60_000);

  it("brain kendi görevleri için hiçbir uzak çağrı yapmaz (machines tanımlı, görevler yerel)", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    const px = await startProxy({ port: await freePort() });
    proxies.push(px);
    w.setPorts({ windows: px.port });
    const id = await w.newTask();
    w.setFront(id, { state: "running", machine: "mac" });
    await runVlad(w.brain, ["status", "--json"]);
    expect(px.count).toBe(0);
  }, 60_000);
});

describe("machines:K — K12 eşzamanlılık ve rezervasyon", () => {
  it("iki gerçek süreç Promise.all, tek slot: her turda tam {1 başarılı, 1 bekletilen}; windows'ta tek pencere", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    for (let i = 0; i < 6; i++) {
      const [a, b] = [await w.newTask(), await w.newTask()];
      const before = w.noop(w.worker).length;
      const [ra, rb] = await Promise.all([runVlad(w.brain, ["task", "launch", a]), runVlad(w.brain, ["task", "launch", b])]);
      const ok = [ra, rb].filter((r) => r.code === 0).length;
      expect([ok, 2 - ok], `tur ${i}: ${ra.err} | ${rb.err}`).toEqual([1, 1]);
      expect(w.noop(w.worker).length - before).toBe(1);
      const states = [a, b].map((id) => front(w!.readTask(w!.brain, id), "state")).sort();
      expect(states).toEqual(["queued", "running"]);
      for (const id of [a, b]) w.setFront(id, { state: "done", machine: "windows" }); // sonraki tur için slotu boşalt
    }
  }, 180_000);

  it("belirsiz launch (işçi uygulama sonrası düştü): rezervasyon kalır; yeniden launch çift pencere AÇMAZ, benimser", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"], { VLAD_TEST_CRASH_AT: "after-apply" });
    const id = await w.newTask();
    const first = await runVlad(w.brain, ["task", "launch", id]);
    expect(first.code).not.toBe(0);
    const t1 = w.readTask(w.brain, id);
    expect(front(t1, "state")).toBe("queued");
    expect(front(t1, "machine")).toBe("windows");
    expect(isNull(front(t1, "machine_reserved"))).toBe(false); // rezervasyon kapasiteden sayılır
    const op1 = front(t1, "launch_op");
    expect(isNull(op1)).toBe(false);
    const placed = w.noop(w.worker).filter((l) => l.taskId === id).length;
    await w.stopAgent("worker");
    await w.startAgents(["worker"]); // aynı home: günlük diskte, açılış uzlaştırması
    const second = await runVlad(w.brain, ["task", "launch", id, "--json"]);
    expect(second.code, second.err).toBe(0);
    expect(w.noop(w.worker).filter((l) => l.taskId === id)).toHaveLength(Math.max(placed, 1)); // ikinci pencere yok
    const t2 = w.readTask(w.brain, id);
    expect(front(t2, "state")).toBe("running");
    expect(isNull(front(t2, "machine_reserved"))).toBe(true);
    expect(isNull(front(t2, "launch_op"))).toBe(true);
  }, 120_000);

  it("rezervasyon kapasiteden sayılır: belirsiz launch beklerken ikinci görev başka makineye taşmaz, bekletilir", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    const reserved = await w.newTask();
    w.setFront(reserved, { machine: "windows", machine_reserved: minsAgo(1), launch_op: randomUUID() });
    const other = await w.newTask();
    const r = await runVlad(w.brain, ["task", "launch", other]);
    expect(r.code).not.toBe(0);
    expect(w.noop(w.worker)).toHaveLength(0);
    expect(w.noop(w.brain)).toHaveLength(0);
  }, 60_000);

  it("11 dk önceki, işçinin hiç görmediği rezervasyon: iptal onayıyla (tombstone) yeniden denenir; eski opId artık çalışmaz", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    const id = await w.newTask();
    const old = randomUUID();
    w.setFront(id, { machine: "windows", machine_reserved: minsAgo(11), launch_op: old });
    const r = await runVlad(w.brain, ["task", "launch", id, "--json"]);
    expect(r.code, r.err).toBe(0);
    const t = w.readTask(w.brain, id);
    expect(front(t, "state")).toBe("running");
    expect(w.noop(w.worker).filter((l) => l.taskId === id)).toHaveLength(1);
    const st = resp(await rawCall({ port: w.agents.worker!.port, key: pairKey(w.pair.keys, "mac", "windows"), from: "mac", to: "windows", op: "op-status", args: { target: old } }));
    expect(st.result.state).toMatch(/cancelled|aborted/);
    // eski opId ile geç gelen launch reddedilir (conflict), pencere açılmaz
    const late = resp(await rawCall({ port: w.agents.worker!.port, key: pairKey(w.pair.keys, "mac", "windows"), from: "mac", to: "windows", op: "launch", opId: old, args: { taskId: id, project: w.slug, repoName: w.repoName, branch: `vlad/${id}`, base: { kind: "default" }, promptTemplate: "x {{TASK_FILE}}", title: "T" } }));
    expect(late.code).toBe("conflict");
    expect(w.noop(w.worker).filter((l) => l.taskId === id)).toHaveLength(1);
  }, 90_000);

  it("kesin launch hatasında rezervasyon temizlenir (op-status 'hiç yok' + failed)", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    const { rmSync } = await import("node:fs");
    rmSync(w.workerRepo, { recursive: true, force: true });
    const id = await w.newTask();
    const r = await runVlad(w.brain, ["task", "launch", id]);
    expect(r.code).not.toBe(0);
    const t = w.readTask(w.brain, id);
    expect(front(t, "state")).not.toBe("running");
    expect(isNull(front(t, "machine_reserved"))).toBe(true);
    // slot tüketilmedi: repo geri gelince aynı kapasiteyle başlar
    git(join(w.base, "roots-windows"), "init", "-q", "-b", "main", w.repoName);
    writeFileSync(join(w.base, "roots-windows", w.repoName, "f"), "x");
    git(join(w.base, "roots-windows", w.repoName), "add", "-A"); git(join(w.base, "roots-windows", w.repoName), "commit", "-q", "-m", "i");
    expect((await runVlad(w.brain, ["task", "launch", id])).code).toBe(0);
  }, 90_000);
});

describe("machines:K — K14 kb eşitleme (gerçek git klonları)", () => {
  const brainSha = (world: World) => git(world.brain.kb, "rev-parse", "HEAD").trim();

  it("başarılı launch: işçi kb'si beyinin HEAD'ine ulaşır (ancestor) ve görev dosyasını görür", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    const id = await w.newTask();
    expect((await runVlad(w.brain, ["task", "launch", id])).code).toBe(0);
    expect(() => git(w!.worker.kb, "merge-base", "--is-ancestor", brainSha(w!), "HEAD")).not.toThrow();
    expect(w.readTask(w.worker, id)).toContain(`id: ${id}`);
  }, 90_000);

  it("kb push edilemiyorsa uzak launch reddedilir 'kb push edilmedi'; pencere açılmaz", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    git(w.brain.kb, "remote", "set-url", "origin", join(w.base, "yok-boyle-bir-origin.git"));
    const id = await w.newTask();
    const r = await runVlad(w.brain, ["task", "launch", id]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("kb push edilmedi");
    expect(w.noop(w.worker)).toHaveLength(0);
    expect(front(w.readTask(w.brain, id), "state")).toBe("queued");
  }, 90_000);

  it("işçi kb klonu ayrışmış: kb-sync failed, launch reddedilir", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    writeFileSync(join(w.worker.kb, "tasks", "yerel.md"), "yerel");
    git(w.worker.kb, "add", "-A"); git(w.worker.kb, "commit", "-q", "-m", "ayrışma");
    const id = await w.newTask();
    const r = await runVlad(w.brain, ["task", "launch", id]);
    expect(r.code).not.toBe(0);
    expect(w.noop(w.worker)).toHaveLength(0);
    expect(front(w.readTask(w.brain, id), "state")).toBe("queued");
  }, 90_000);

  it("işçi kb ağacı kirli (izlenen dosya değişmiş): kb-sync failed, launch reddedilir", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    writeFileSync(join(w.worker.kb, ".gitignore"), "elle-degistirildi\n");
    const id = await w.newTask();
    const r = await runVlad(w.brain, ["task", "launch", id]);
    expect(r.code).not.toBe(0);
    expect(w.noop(w.worker)).toHaveLength(0);
  }, 90_000);

  it("kb-sync: beklenen sha origin'de yoksa failed; var ise ok ve HEAD'in atası", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    const call = async (expectSha: string) => resp(await rawCall({ port: w!.agents.worker!.port, key: pairKey(w!.pair.keys, "mac", "windows"), from: "mac", to: "windows", op: "kb-sync", args: { expectSha } }));
    expect((await call("a".repeat(40))).code).toBe("failed");
    expect((await call(brainSha(w))).code).toBe("ok");
    expect((await call("--upload-pack=x")).code).toBe("bad_request");
  }, 60_000);
});
