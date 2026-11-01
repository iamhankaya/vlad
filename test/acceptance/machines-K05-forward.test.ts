// K5 — Windows (işçi) `task log/ask/report/session` yazmaları beyne gider; çıktı/çıkış kodu doğrudan beyin CLI'ı ile aynı.
// K6 — 1 MB Türkçe/CRLF/özel karakterli rapor bayt bayt korunur (ayrı dosya: büyük yük).
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { front, makeWorld, runVlad, type World } from "./machines-world.js";

let w: World | undefined;
afterEach(async () => { await w?.cleanup(); w = undefined; });

/** iki ikiz görev: `viaWorker` işçiden, `direct` beyinden yazılır; ikisi de windows'a ait ve running. */
async function twins(world: World) {
  const viaWorker = await world.newTask();
  const direct = await world.newTask();
  for (const id of [viaWorker, direct]) world.setFront(id, { state: "running", machine: "windows" });
  return { viaWorker, direct };
}
const norm = (s: string, ids: string[]) => ids.reduce((a, id, i) => a.split(id).join(`<ID${i}>`), s).replace(/\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/g, "<ISO>");
const section = (txt: string, name: string) => { const m = txt.replace(/\r\n/g, "\n").split(`\n## ${name}\n`)[1]; return (m ?? "").split("\n## ")[0]; };

describe("machines:K — K5 işçi yazmaları beyne iletilir", () => {
  it.each([
    ["log", (id: string) => ["task", "log", id, "merhaba dünya", "--json"], undefined],
    ["ask", (id: string) => ["task", "ask", id, "ne yapalım?", "--json"], undefined],
    ["report", (id: string) => ["task", "report", id, "--file", "-", "--json"], "### Yapılanlar\n- iş bitti\n"],
    ["session", (id: string) => ["task", "session", id, "sess-123", "--json"], undefined],
  ])("%s: stdout/stderr/çıkış kodu doğrudan CLI ile eşit, dosya beyin home'unda", async (_n, argv, stdin) => {
    w = await makeWorld();
    await w.startAgents();
    const { viaWorker, direct } = await twins(w);
    const a = await runVlad(w.worker, argv(viaWorker), { stdin });
    const b = await runVlad(w.brain, argv(direct), { stdin });
    expect(b.code, b.err).toBe(0);
    expect({ code: a.code, out: norm(a.out, [viaWorker, direct]), err: norm(a.err, [viaWorker, direct]) })
      .toEqual({ code: b.code, out: norm(b.out, [viaWorker, direct]), err: norm(b.err, [viaWorker, direct]) });
    // iki taraftaki görev dosyası aynı (zaman damgası/ID hariç) değişti; işçi home'unda görev yok
    expect(norm(w.readTask(w.brain, viaWorker), [viaWorker, direct]).replace(/updated: .*/, ""))
      .toBe(norm(w.readTask(w.brain, direct), [viaWorker, direct]).replace(/updated: .*/, ""));
    expect(() => w!.taskFile(w!.worker, viaWorker)).toThrow();
  }, 60_000);

  it("hata yolu: olmayan görev — işçiden ve beyinden aynı stderr + çıkış kodu", async () => {
    w = await makeWorld();
    await w.startAgents();
    const a = await runVlad(w.worker, ["task", "log", "T20990101-99", "x", "--json"]);
    const b = await runVlad(w.brain, ["task", "log", "T20990101-99", "x", "--json"]);
    expect(b.code).toBe(1);
    expect({ code: a.code, err: a.err }).toEqual({ code: b.code, err: b.err });
  }, 60_000);

  it("başka makinenin görevi: işçi kimliği yazamaz, dosya değişmez (forbidden)", async () => {
    w = await makeWorld();
    await w.startAgents();
    const id = await w.newTask();
    w.setFront(id, { state: "running", machine: "mac" }); // windows'un değil
    const before = w.readTask(w.brain, id);
    const r = await runVlad(w.worker, ["task", "log", id, "sızma", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toMatch(/forbidden|başka makine/);
    expect(w.readTask(w.brain, id)).toBe(before);
  }, 60_000);

  it("iletim listesi dışı yazma (task set / task new) işçide çıkış 1 'bu makine beyin değil'; yerel kb'ye dokunulmaz", async () => {
    w = await makeWorld();
    await w.startAgents();
    const id = await w.newTask();
    w.setFront(id, { state: "running", machine: "windows" });
    const r = await runVlad(w.worker, ["task", "set", id, "done"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("bu makine beyin değil");
    expect(front(w.readTask(w.brain, id), "state")).toBe("running");
    const n = await runVlad(w.worker, ["task", "new", "--project", w.slug, "--title", "x", "--kind", "dev", "--body-file", "-"], { stdin: "x" });
    expect(n.code).toBe(1);
  }, 60_000);

  it("yerel Agent çalışmıyorsa işçi yazması kuyruğa değil çıkış 75 (açıklayıcı)", async () => {
    w = await makeWorld();
    await w.startAgents(["brain"]); // işçi Agent'ı yok
    const { viaWorker } = await twins(w);
    const r = await runVlad(w.worker, ["task", "log", viaWorker, "x"]);
    expect(r.code).toBe(75);
    expect(r.err).toContain("VLAD Agent çalışmıyor");
  }, 60_000);

  it("VLAD_FORWARDED döngüsü: iletilmiş istek beyinde yeniden iletilmez (tek uygulama)", async () => {
    w = await makeWorld();
    await w.startAgents();
    const { viaWorker } = await twins(w);
    await runVlad(w.worker, ["task", "log", viaWorker, "tek-satir"]);
    expect(w.readTask(w.brain, viaWorker).split("tek-satir").length - 1).toBe(1);
  }, 60_000);
});

describe("machines:K — K6 büyük ve özel karakterli rapor", () => {
  const tricky = "Türkçe: çğıöşü İĞÜŞÖÇ — “tırnak” \"çift\" 'tek' $HOME $(id) `bt` \\n \\\\ %PATH% 😀\r\n";
  const body = (n: number) => "### Yapılanlar\r\n" + tricky.repeat(Math.ceil(n / tricky.length));

  it("1 MB rapor işçiden iletilir; kapanış raporu bölümü doğrudan CLI ile birebir (sha256)", async () => {
    w = await makeWorld();
    await w.startAgents();
    const { viaWorker, direct } = await twins(w);
    const md = body(1_000_000);
    const a = await runVlad(w.worker, ["task", "report", viaWorker, "--file", "-", "--json"], { stdin: md, timeoutMs: 40_000 });
    const b = await runVlad(w.brain, ["task", "report", direct, "--file", "-", "--json"], { stdin: md });
    expect(b.code, b.err).toBe(0);
    expect(a.code, a.err).toBe(0);
    const sha = (id: string) => createHash("sha256").update(section(w!.readTask(w!.brain, id), "Kapanış raporu")).digest("hex");
    expect(sha(viaWorker)).toBe(sha(direct));
    expect(section(w.readTask(w.brain, viaWorker), "Kapanış raporu").length).toBeGreaterThan(900_000);
  }, 90_000);
});
