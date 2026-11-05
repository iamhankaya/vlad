// K7 — Beyin ulaşılamazken işçi yazmaları yerel kuyruğa girer; bağlantı gelince sırayla, kayıpsız, çiftsiz iletilir.
// Kaynak: plan "Kuyruk ve Windows'ta beyin yazmaları" + "opId günlüğü ve uzlaştırma". Çökme noktası env adı (VLAD_TEST_CRASH_AT=after-apply) plan K7'den; uygulama farklı adlandırırsa raporda itiraz.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startProxy, type Proxy } from "../machines/harness.js";
import { front, makeWorld, runVlad, type World } from "./machines-world.js";

let w: World | undefined;
let px: Proxy | undefined;
afterEach(async () => { await px?.stop(); px = undefined; await w?.cleanup(); w = undefined; });

/** işçi→beyin arasına vekil konur: önce beyin Agent'ı, vekil, sonra işçi Agent'ı (işçi config'ten vekil portunu okur). */
async function setup(test?: Record<string, string>) {
  w = await makeWorld();
  await w.startAgents(["brain"], test);
  px = await startProxy({ port: w.agents.brain!.port });
  w.setPorts({ mac: px.port });
  await w.startAgents(["worker"]);
  return { w, px };
}
const mkTask = async (world: World, machine = "windows") => { const id = await world.newTask(); world.setFront(id, { state: "running", machine }); return id; };
/** flush, hâlihazırda çalışan arka plan boşaltmasına denk gelirse hemen döner (queue.ts `flushing`); koşul gerçekleşene kadar bekler. Bkz. kapanış raporu bulgusu. */
const until = async (cond: () => boolean, ms = 20_000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 200)); };
const count = (txt: string, needle: string) => txt.split(needle).length - 1;
const logs = (world: World, id: string) => { const t = world.readTask(world.brain, id); return [...t.matchAll(/^- \S+ (L\d)$/gm)].map((m) => m[1]); };
const queueList = async (world: World) => {
  const r = await runVlad(world.worker, ["queue", "list", "--json"]);
  expect(r.code, r.err).toBe(0);
  const j = JSON.parse(r.out);
  return (j.entries ?? j) as { seq: number; opId: string; cmd: string; id: string; state: string }[];
};

describe("machines:K — K7 kuyruk", () => {
  it("beyin kapalı: 3 yazma kuyruğa (çıkış 0, queued JSON), sıra seq; bağlantı gelince aynı sırayla ve bir kez uygulanır", async () => {
    const { w, px } = await setup();
    const id = await mkTask(w);
    px.down();
    const seqs: number[] = [];
    for (const m of ["L1", "L2", "L3"]) {
      const r = await runVlad(w.worker, ["task", "log", id, m, "--json"]);
      expect(r.code, r.err).toBe(0);
      const j = JSON.parse(r.out);
      expect(j.queued).toBe(true);
      seqs.push(j.seq);
    }
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);
    expect(logs(w, id)).toEqual([]);
    expect((await queueList(w)).map((e) => e.cmd)).toEqual(["task.log", "task.log", "task.log"]);
    px.up();
    const f = await runVlad(w.worker, ["queue", "flush"]);
    expect(f.code, f.err).toBe(0);
    expect(logs(w, id)).toEqual(["L1", "L2", "L3"]);
    expect(await queueList(w)).toEqual([]);
    // ikinci flush hiçbir şey eklemez
    await runVlad(w.worker, ["queue", "flush"]);
    expect(logs(w, id)).toEqual(["L1", "L2", "L3"]);
  }, 90_000);

  it("kuyruk doluyken yeni yazma doğrudan geçmez, sıraya girer (sıra bozulmaz)", async () => {
    const { w, px } = await setup();
    const id = await mkTask(w);
    px.down();
    await runVlad(w.worker, ["task", "log", id, "L1"]);
    px.up(); // beyin geri geldi ama kuyrukta L1 var
    const r = await runVlad(w.worker, ["task", "log", id, "L2", "--json"]);
    expect(r.code, r.err).toBe(0);
    await runVlad(w.worker, ["queue", "flush"]);
    await until(() => logs(w, id).length >= 2);
    expect(logs(w, id)).toEqual(["L1", "L2"]);
  }, 90_000);

  it("yanıt kaybı (istek işlendi, yanıt düştü): flush aynı opId'yi yeniden oynatır, görev satırı bir kez", async () => {
    const { w, px } = await setup();
    const id = await mkTask(w);
    px.dropResponse(1);
    const r = await runVlad(w.worker, ["task", "log", id, "L1", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).queued).toBe(true);
    expect(logs(w, id)).toEqual(["L1"]); // beyin uyguladı
    await runVlad(w.worker, ["queue", "flush"]);
    expect(logs(w, id)).toEqual(["L1"]); // tekrar uygulanmadı
    expect(await queueList(w)).toEqual([]);
  }, 90_000);

  it("yanıt kaybında ask: durum/metin çiftlenmez; ilk çıktı korunur", async () => {
    const { w, px } = await setup();
    const id = await mkTask(w);
    px.dropResponse(1);
    await runVlad(w.worker, ["task", "ask", id, "SORU-1?", "--json"]);
    await runVlad(w.worker, ["queue", "flush"]);
    const t = w.readTask(w.brain, id);
    expect(count(t, "SORU-1?")).toBe(1);
    expect(front(t, "state")).toBe("blocked");
  }, 90_000);

  it("kalıcı hata: ilgili giriş failed/'e, aynı görevin sonraki girdileri de; diğer görevin girdisi devam eder", async () => {
    const { w, px } = await setup();
    const a = await mkTask(w), b = await mkTask(w);
    px.down();
    await runVlad(w.worker, ["task", "log", a, "L1"]);
    await runVlad(w.worker, ["task", "log", a, "L2"]);
    await runVlad(w.worker, ["task", "log", b, "L3"]);
    w.setFront(a, { machine: "mac" }); // artık windows'un değil → forbidden (kalıcı)
    px.up();
    await runVlad(w.worker, ["queue", "flush"]);
    expect(logs(w, a)).toEqual([]);
    expect(logs(w, b)).toEqual(["L3"]);
    const q = await queueList(w);
    expect(q.filter((e) => e.state === "failed").map((e) => e.id)).toEqual([a, a]);
    expect(q.filter((e) => e.state !== "failed")).toEqual([]);
  }, 90_000);

  it("bozuk JSON kuyruk girdisi failed'e taşınır, sonrakiler gider", async () => {
    const { w, px } = await setup();
    const id = await mkTask(w);
    px.down();
    await runVlad(w.worker, ["task", "log", id, "L1"]);
    const qdir = join(w.worker.home, ".vlad-agent", "queue");
    expect(existsSync(qdir)).toBe(true);
    writeFileSync(join(qdir, "00000000-bozuk.json"), "{{{ bozuk");
    px.up();
    await runVlad(w.worker, ["queue", "flush"]);
    expect(logs(w, id)).toEqual(["L1"]);
    expect(readdirSync(qdir).filter((n) => n.endsWith(".json"))).toEqual([]); // pending kalmadı
    expect(existsSync(join(qdir, "failed")) || existsSync(join(w.worker.home, ".vlad-agent", "failed"))).toBe(true);
  }, 90_000);

  it("işçi Agent'ı yeniden başlayınca kuyruk diskten yüklenir; flush sonra kayıpsız", async () => {
    const { w, px } = await setup();
    const id = await mkTask(w);
    px.down();
    await runVlad(w.worker, ["task", "log", id, "L1"]);
    await runVlad(w.worker, ["task", "log", id, "L2"]);
    await w.stopAgent("worker");
    await w.startAgents(["worker"]); // beyin hâlâ kapalı: açılıştaki tick() (start.ts) kuyruğu boşaltamaz (F-vlad-131)
    expect((await queueList(w)).length).toBe(2);
    px.up();
    await runVlad(w.worker, ["queue", "flush"]);
    await until(() => logs(w, id).length >= 2);
    expect(logs(w, id)).toEqual(["L1", "L2"]);
  }, 90_000);

  it("queue drop <seq> girdiyi siler ve uygulanmaz", async () => {
    const { w, px } = await setup();
    const id = await mkTask(w);
    px.down();
    await runVlad(w.worker, ["task", "log", id, "L1"]);
    await runVlad(w.worker, ["task", "log", id, "L2"]);
    const [first] = await queueList(w);
    expect((await runVlad(w.worker, ["queue", "drop", String(first.seq)])).code).toBe(0);
    px.up();
    await runVlad(w.worker, ["queue", "flush"]);
    expect(logs(w, id)).toEqual(["L2"]);
  }, 90_000);
});

describe("machines:K — K7 çökme penceresi (beyin uygulamadan sonra düşer)", () => {
  const crashSetup = async () => {
    w = await makeWorld();
    await w.startAgents(["brain"], { VLAD_TEST_CRASH_AT: "after-apply" });
    await w.startAgents(["worker"]);
    return w;
  };
  const restartBrain = async (world: World) => {
    await world.stopAgent("brain");
    await world.startAgents(["brain"]); // aynı home: günlük diskte
    await world.stopAgent("worker");
    await world.startAgents(["worker"]); // yeni brain portunu config'ten alsın; kuyruk diskten gelir
  };

  it("ask/report/session çiftlenmez", async () => {
    const world = await crashSetup();
    const id = await mkTask(world);
    const r = await runVlad(world.worker, ["task", "ask", id, "ÇÖKME-SORU?", "--json"]);
    expect(r.code, r.err).toBe(0);
    await restartBrain(world);
    await runVlad(world.worker, ["queue", "flush"]);
    const t = world.readTask(world.brain, id);
    expect(count(t, "ÇÖKME-SORU?")).toBe(1);
    expect(front(t, "state")).toBe("blocked");
    expect(await queueList(world)).toEqual([]);
  }, 90_000);

  it("log en çok +1 satır (belgelenmiş 'çok nadir çift' garantisi), asla kayıp değil", async () => {
    const world = await crashSetup();
    const id = await mkTask(world);
    await runVlad(world.worker, ["task", "log", id, "L1"]);
    await restartBrain(world);
    await runVlad(world.worker, ["queue", "flush"]);
    const n = logs(world, id).filter((x) => x === "L1").length;
    expect(n === 1 || n === 2).toBe(true);
  }, 90_000);
});
