// Kabul (T20261111-51, F-vlad-314): `vlad task close` uzak tek görevde — gate (işçi) → push → fetch → merge (BEYİN) — uçtan uca.
// Sahte uzak işçi = gerçek Agent + bare origin + iki klon (mevcut machines-world/harness altyapısı). Kaynak: spec raporu T20261111-49
// "close akışı", senaryo 1, 6, 10, 15, 16, 20; kabul kriterleri 7-10. Uygulamaya bakılmadan yazıldı: KIRMIZI başlar.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { front, git, runVlad } from "./machines-world.js";
import { makeBpWorld, report, type BpWorld } from "./branch-push-world.js";

let b: BpWorld | undefined;
afterEach(async () => { await b?.w.cleanup(); b = undefined; });
const T = 180_000;

async function ready(o: { gate?: string } = {}): Promise<BpWorld> {
  b = await makeBpWorld(o);
  await report(b);
  return b;
}
const close = async (x: BpWorld, argv: string[] = ["--yes"]) => {
  const r = await runVlad(x.w.brain, ["task", "close", x.id, ...argv, "--json"], { timeoutMs: 150_000 });
  let json: any = null;
  try { json = JSON.parse(r.out); } catch { /* JSON yok */ }
  return { ...r, json };
};
const names = (j: any) => (j?.steps ?? []).map((s: any) => s.step);
const status = (j: any, s: string) => (j?.steps ?? []).find((x: any) => x.step === s)?.status;
const brainMain = (x: BpWorld) => git(x.w.brainRepo, "rev-parse", "main").trim();
const brainHas = (x: BpWorld, f: string) => existsSync(join(x.w.brainRepo, f));
const journalOps = (x: BpWorld, op: string) => {
  const f = join(x.w.worker.home, ".vlad-agent", "journal.jsonl");
  const rows = existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return [...new Map(rows.filter((r) => r.op === op).map((r) => [r.opId, r])).values()];
};

describe("task close (uzak tek görev): push → fetch → beyinde merge", () => {
  it("senaryo 1: tam akış; dal origin'e gider, beyin fetch eder ve BEYİNDE --no-ff merge eder; günlük satırı yazılır", async () => {
    const x = await ready();
    const gated = git(x.wt, "rev-parse", "HEAD").trim();
    const mainBefore = brainMain(x);
    const workerMainBefore = git(x.w.workerRepo, "rev-parse", "main").trim();
    const r = await close(x);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json).toMatchObject({ ok: true, stopped_at: null, head: gated });
    expect(names(r.json)).toEqual(["precheck", "gate", "push", "fetch", "conflict", "confirm", "merge", "done", "cleanup", "findings", "kb"]);
    // origin: yalnız vlad/<id> eklendi, ana dal origin'e itilmedi
    expect(x.originRefs()).toEqual({ "refs/heads/main": mainBefore, [`refs/heads/vlad/${x.id}`]: gated });
    // merge beyinde: iki ebeveynli commit, dosya beyin ana dalında
    expect(brainHas(x, "is.txt")).toBe(true);
    expect(git(x.w.brainRepo, "log", "-1", "--format=%p", "main").trim().split(" ")).toHaveLength(2);
    expect(git(x.w.brainRepo, "merge-base", "--is-ancestor", gated, "main")).toBeDefined();
    expect(brainMain(x)).not.toBe(mainBefore);
    // işçi ana dalı merge'ü yapmadı (spec açık nokta 3: bayatlama ayrı bulgu)
    expect(git(x.w.workerRepo, "rev-parse", "main").trim()).toBe(workerMainBefore);
    // beyinde yerel vlad/<id> dalı yaratılmadı
    expect(git(x.w.brainRepo, "branch", "--list", `vlad/${x.id}`).trim()).toBe("");
    // durum + günlük + Agent günlüğü
    const txt = x.w.readTask(x.w.brain, x.id);
    expect(front(txt, "state")).toBe("done");
    expect(txt).toContain(`branch-push: vlad/${x.id} @ ${gated.slice(0, 12)} origin'e itildi (windows)`);
    // 2 op: ilki gerçek push, ikincisi push değil merge öncesi uç doğrulaması (aynı sha, idempotent; F-vlad-320, karar T20261112-08); gerçek push yine 1 (aşağıda)
    expect(journalOps(x, "branch-push")).toHaveLength(2);
    expect(journalOps(x, "merge")).toHaveLength(0); // merge işçiye gitmedi
    expect(x.pushes()).toHaveLength(1);
  }, T);

  it("onay durağı: --yes yok → push+fetch yapılmış, merge yok; --yes --head ile devam, push tekrarı zararsız", async () => {
    const x = await ready();
    const gated = git(x.wt, "rev-parse", "HEAD").trim();
    const mainBefore = brainMain(x);
    const first = await close(x, []);
    expect(first.json).toMatchObject({ ok: false, stopped_at: "confirm", head: gated });
    expect(status(first.json, "push")).toBe("ok");
    expect(x.originRefs()[`refs/heads/vlad/${x.id}`]).toBe(gated);
    expect(brainMain(x)).toBe(mainBefore);
    expect(brainHas(x, "is.txt")).toBe(false);
    expect(front(x.w.readTask(x.w.brain, x.id), "state")).toBe("awaiting_approval");
    const ok = await close(x, ["--yes", "--head", gated.slice(0, 12)]);
    expect(ok.json, ok.out + ok.err).toMatchObject({ ok: true });
    expect(brainHas(x, "is.txt")).toBe(true);
    expect(x.pushes()).toHaveLength(1); // ikinci koşuda origin zaten gated sha'da: push yok (pushed:false)
  }, T);

  it("senaryo 20: --head gate'lenen head'den farklı → push öncesi durur; origin ve beyin değişmez", async () => {
    const x = await ready();
    const r = await close(x, ["--yes", "--head", "deadbee"]);
    expect(r.json).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(x.pushes()).toHaveLength(0);
    expect(x.originRefs()[`refs/heads/vlad/${x.id}`]).toBeUndefined();
    expect(brainHas(x, "is.txt")).toBe(false);
  }, T);

  it("kırmızı gate'te push yok (kırmızı kod origin'e gitmez)", async () => {
    b = await makeBpWorld({ gate: `node -e "process.exit(3)"` });
    await report(b);
    const r = await close(b);
    expect(r.json).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(names(r.json)).not.toContain("push");
    expect(b.pushes()).toHaveLength(0);
    expect(b.originRefs()[`refs/heads/vlad/${b.id}`]).toBeUndefined();
  }, T);
});

describe("task close (uzak tek görev): hata yolları — net hata, merge yok", () => {
  it("push hatası (işçide origin yok): stopped_at push, reason [no_origin]; beyin ana dalı ve görev durumu değişmez", async () => {
    const x = await ready();
    git(x.w.workerRepo, "remote", "remove", "origin");
    const mainBefore = brainMain(x);
    const r = await close(x);
    expect(r.code).not.toBe(0);
    expect(r.json).toMatchObject({ ok: false, stopped_at: "push" });
    expect(r.json.reason).toContain("no_origin");
    expect(names(r.json)).not.toContain("fetch");
    expect(brainMain(x)).toBe(mainBefore);
    expect(brainHas(x, "is.txt")).toBe(false);
    expect(front(x.w.readTask(x.w.brain, x.id), "state")).toBe("awaiting_approval");
    expect(x.w.readTask(x.w.brain, x.id)).not.toContain("origin'e itildi");
  }, T);

  it("senaryo 6: origin'de farklı (ata olmayan) uç → stopped_at push, reason diverged; yabancı uç ezilmez", async () => {
    const x = await ready();
    const foreign = x.pushForeign();
    const r = await close(x);
    expect(r.json).toMatchObject({ ok: false, stopped_at: "push" });
    expect(r.json.reason).toContain("diverged");
    expect(x.originRefs()[`refs/heads/vlad/${x.id}`]).toBe(foreign);
    expect(brainHas(x, "is.txt")).toBe(false);
  }, T);

  it("senaryo 15: beyin başka bir origin'den fetch ediyor (dal yok) → stopped_at fetch; merge yok, görev awaiting_approval", async () => {
    const x = await ready();
    const other = join(x.w.base, "origin-baska.git");
    git(x.w.base, "clone", "-q", "--bare", x.origin, other);
    git(x.w.brainRepo, "remote", "set-url", "origin", other);
    const mainBefore = brainMain(x);
    const r = await close(x);
    expect(r.json).toMatchObject({ ok: false, stopped_at: "fetch" });
    expect(status(r.json, "push")).toBe("ok"); // dal işçinin origin'ine gitti; beyin onu göremedi
    expect(brainMain(x)).toBe(mainBefore);
    expect(brainHas(x, "is.txt")).toBe(false);
    expect(front(x.w.readTask(x.w.brain, x.id), "state")).toBe("awaiting_approval");
  }, T);

  it("Agent erişilemez: push adımında net hata (geçici), merge yok", async () => {
    const x = await ready();
    // gate bitince Agent düşemez; bu yüzden Agent baştan kapalı: gate adımı hata verir ya da push'ta durur — her durumda merge yok
    await x.w.stopAgent("worker");
    const mainBefore = brainMain(x);
    const r = await close(x);
    expect(r.code).not.toBe(0);
    expect(r.json?.ok ?? false).toBe(false);
    expect(["gate", "push"]).toContain(r.json?.stopped_at ?? "gate");
    expect(brainMain(x)).toBe(mainBefore);
    expect(brainHas(x, "is.txt")).toBe(false);
  }, T);
});

describe("task close (uzak tek görev): yeniden koşu (done) — idempotent", () => {
  it("senaryo 16: tamamlanmış görevde yeniden koşu push/fetch/merge'i atlar; ikinci branch-push op'u yok", async () => {
    const x = await ready();
    expect((await close(x)).json).toMatchObject({ ok: true });
    const mainAfter = brainMain(x);
    const again = await close(x);
    expect(again.json, again.out + again.err).toMatchObject({ ok: true });
    for (const s of ["push", "fetch", "merge"]) expect(["skipped", undefined], s).toContain(status(again.json, s));
    expect(brainMain(x)).toBe(mainAfter);
    // ilk koşudaki push + merge öncesi doğrulama = 2; yeniden koşu (done) üçüncüyü eklemez (F-vlad-320, karar T20261112-08)
    expect(journalOps(x, "branch-push")).toHaveLength(2);
  }, T);

  it("F-vlad-308 uzak kısmı: görev done ama gate'lenen head hedefte değil → precheck'te durur (merge edilmemiş)", async () => {
    const x = await ready();
    const first = await close(x, []); // gate + push + fetch, merge yok (onay durağı)
    expect(first.json).toMatchObject({ stopped_at: "confirm" });
    x.w.setFront(x.id, { state: "done" });
    expect((await runVlad(x.w.brain, ["kb", "commit", "elle-done", "--push"])).code).toBe(0);
    const r = await close(x);
    expect(r.json).toMatchObject({ ok: false, stopped_at: "precheck" });
    expect(r.json.reason).toMatch(/merge/i);
    expect(brainHas(x, "is.txt")).toBe(false);
  }, T);
});
