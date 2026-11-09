// Kabul (T20261109-06, çatı T20261109-03): `vlad machine scripts|run` CLI'ı gerçek süreçlerle (beyin CLI → işçi Agent alt süreci → gerçek git deposunda bash betiği).
// Kaynak: spec raporu (T20261109-04) "CLI yüzeyi", "Write onay modeli", S16/S17/S21/S22/S23, KK6/KK8. Yalnız geçici dizin; işçinin VLAD_HOME'u temp'te bir git deposu.
// Uygulama yokken KIRMIZI beklenir (CLI gövdeleri "henüz gerçeklenmedi"). Çıkış kodları: betik 0 → 0; betik ≠0 → 1; geçici RemoteError (unreachable|timeout|busy|clock_skew) → 75; diğer → 1.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptPlanId } from "../../src/agent/scripts/manifest.js";
import { PLAT, makeScriptRepo, type ScriptRepo } from "../support/script-repo.js";
import { SCRIPTS } from "../support/script-fixtures.js";
import { makeWorld, runVlad, type World } from "./machines-world.js";

let w: World | undefined;
afterEach(async () => { await w?.cleanup(); w = undefined; });

const sha = (fx: ScriptRepo, name: string) => fx.entry(SCRIPTS.find((s) => s.name === name)!).sha256;
const planOf = (fx: ScriptRepo, name: string, params: Record<string, string> = {}) =>
  scriptPlanId({ machine: "windows", name, platform: PLAT, sha256: sha(fx, name), params });
const until = async (f: () => boolean, ms = 15_000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("beklenen koşul oluşmadı"); await new Promise((r) => setTimeout(r, 50)); } };
const journal = (home: string) => {
  const f = join(home, ".vlad-agent", "journal.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const lastRec = (home: string, opId: string) => journal(home).filter((r) => r.opId === opId).at(-1);

/** Beyin + işçi dünyası; işçi home'u git deposu (origin'li) olarak betiklerle kurulur, sonra işçi Agent'ı başlar. */
async function world(o: { test?: Record<string, string>; scripts?: typeof SCRIPTS } = {}) {
  w = await makeWorld({});
  const fx = makeScriptRepo(w.worker.home, join(w.base, "scripts-origin.git"), o.scripts ?? SCRIPTS);
  await w.startAgents(["worker"], o.test);
  const brain = (...argv: string[]) => runVlad(w!.brain, ["machine", ...argv]);
  return { w, fx, brain, wt: w.worker };
}
const parse = (out: string) => JSON.parse(out);

describe.skipIf(process.platform === "win32")("scripts CLI: machine scripts", () => {
  it("scripts <ad>: işçinin kayıtlı betiklerini, sınıfını ve bütünlük durumunu listeler (--json ve metin)", async () => {
    const { brain } = await world();
    const j = await brain("scripts", "windows", "--json");
    expect(j.code, j.err).toBe(0);
    const doc = parse(j.out);
    const scripts: { name: string; class: string; integrity: string }[] = Array.isArray(doc) ? doc : doc.scripts;
    expect(scripts.find((s) => s.name === "mark-write")).toMatchObject({ class: "write", integrity: "ok" });
    expect(scripts.find((s) => s.name === "show-env")).toMatchObject({ class: "read", integrity: "ok" });
    const t = await brain("scripts", "windows");
    expect(t.code, t.err).toBe(0);
    for (const n of ["show-env", "mark-write", "hold"]) expect(t.out).toContain(n);
  });
  it("bütünlüğü bozuk betik uyarıyla listelenir (integrity ≠ ok)", async () => {
    const { brain, fx } = await world();
    writeFileSync(join(fx.repo, "agent-scripts", "mark-read.sh"), "#!/bin/bash\necho x\n");
    const doc = parse((await brain("scripts", "windows", "--json")).out);
    const scripts: { name: string; integrity: string }[] = Array.isArray(doc) ? doc : doc.scripts;
    expect(scripts.find((s) => s.name === "mark-read")!.integrity).toBe("dirty");
  });
  it("bilinmeyen makine → çıkış 1 ve açık hata", async () => {
    const { brain } = await world();
    const r = await brain("scripts", "yok-makine");
    expect(r.code).toBe(1);
    expect(r.err, "hata hangi makinenin bilinmediğini söylemeli").toContain("yok-makine");
  });
});

describe.skipIf(process.platform === "win32")("scripts CLI: machine run (read) — çıkış kodları ve JSON", () => {
  it("read betiği: çıkış 0, --json ScriptRunResult + opId; --param k=v ortamdan görünür", async () => {
    const { brain } = await world();
    const r = await brain("run", "windows", "show-env", "--param", "msg=hi", "--json");
    expect(r.code, r.err).toBe(0);
    const j = parse(r.out);
    expect(j).toMatchObject({ name: "show-env", exit: 0, timedOut: false, platform: PLAT });
    expect(j.data).toMatchObject({ msg: "hi" });
    expect(typeof j.opId).toBe("string");
  });
  it("metin çıktısı betik çıktısını gösterir; betik exit≠0 → CLI çıkış 1 ve stderr özeti", async () => {
    const { brain } = await world();
    const ok = await brain("run", "windows", "show-env");
    expect(ok.code, ok.err).toBe(0);
    const bad = await brain("run", "windows", "fail3");
    expect(bad.code).toBe(1);
    expect(bad.out + bad.err).toContain("oops");
  });
  it("kayıtsız betik / bozuk parametre → çıkış 1, neden mesajda; geçici değil (75 değil)", async () => {
    const { brain, fx } = await world();
    const a = await brain("run", "windows", "rm-rf");
    expect(a.code).toBe(1);
    expect(a.err).toContain("unregistered");
    const b = await brain("run", "windows", "typed", "--param", "tag=-rf");
    expect(b.code).toBe(1);
    expect(b.err).toContain("bad_param:tag");
    expect(fx.lines("typed")).toEqual([]);
  });
  it("--param k=v ilk '='ten bölünür (değer '=' içerebilir; anahtar kesilmez)", async () => {
    const { brain } = await world();
    const r = await brain("run", "windows", "typed", "--param", "tag=a=b");
    expect(r.code).toBe(1);
    expect(r.err).toContain("bad_param:tag"); // anahtar "tag", değer "a=b" (varsayılan desen '=' reddeder); son '='ten bölünseydi anahtar "tag=a" olurdu
    expect(r.err).not.toContain("bad_param:tag=a");
  });
  it("tekrarlanan --param anahtarı ve '=' içermeyen --param reddedilir; betik başlamaz", async () => {
    const { brain, fx } = await world();
    const dup = await brain("run", "windows", "typed", "--param", "tag=a", "--param", "tag=b");
    expect(dup.code).toBe(1);
    expect(dup.err, "hata kopya anahtarı (tag) adlandırmalı").toContain("tag");
    expect(dup.err).not.toContain("gerçeklenmedi");
    const nokv = await brain("run", "windows", "typed", "--param", "tagx");
    expect(nokv.code).toBe(1);
    expect(nokv.err, "hata bozuk --param değerini (tagx) göstermeli").toContain("tagx");
    expect(nokv.err).not.toContain("gerçeklenmedi");
    expect(fx.lines("typed")).toEqual([]);
  });
  it("--param konumsal argümanları yutmaz: parametreler betik adından önce de gelebilir", async () => {
    const { brain } = await world();
    const r = await brain("run", "--param", "msg=on", "windows", "show-env", "--param", "mode=slow", "--json");
    expect(r.code, r.err).toBe(0);
    expect(parse(r.out).data).toMatchObject({ msg: "on", mode: "slow" });
  });
  it("--op-id: aynı opId ile ikinci çağrı betiği tekrar koşmaz (replay); sonuç aynı", async () => {
    const { brain, fx } = await world();
    const a = await brain("run", "windows", "mark-read", "--op-id", "cli-op-1", "--json");
    const b = await brain("run", "windows", "mark-read", "--op-id", "cli-op-1", "--json");
    expect(a.code, a.err).toBe(0); expect(b.code, b.err).toBe(0);
    expect(fx.lines("mark-read")).toEqual(["cli-op-1"]);
    expect(JSON.stringify(parse(b.out))).toContain("replayed");
    expect(parse(b.out).opId).toBe("cli-op-1");
  });
  it("zaman aşımı: betik timeoutSec'i aşar → exit 124 / timedOut; CLI çıkış 1 (betik başarısız); istemci zaman aşımı timeoutSec+30 (varsayılan 70 sn'ye takılmaz)", async () => {
    const { brain } = await world();
    const r = await brain("run", "windows", "sleeper", "--json");
    expect(r.code, r.err).toBe(1);
    expect(parse(r.out)).toMatchObject({ timedOut: true, exit: 124 });
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("scripts CLI: write onayı (--plan / --confirmed) — KK6", () => {
  it("--plan çağrı yapmadan betik, sınıf, çözümlenmiş parametreler ve plan-id'yi yazar; betik çalışmaz", async () => {
    const { brain, fx } = await world();
    const r = await brain("run", "windows", "mark-write", "--plan");
    expect(r.code, r.err).toBe(0);
    const id = planOf(fx, "mark-write");
    expect(r.out).toContain(id);
    expect(r.out).toContain("mark-write");
    expect(r.out).toContain("write");
    expect(fx.lines("mark-write")).toEqual([]);
    const j = await brain("run", "windows", "mark-write", "--plan", "--json");
    expect(j.code, j.err).toBe(0);
    expect(JSON.stringify(parse(j.out))).toContain(id);
  });
  it("--plan çözümlenmiş parametreyi (manifest default'u dahil) plan-id'ye katar", async () => {
    const wp = [{ name: "pw", class: "write" as const, params: [{ name: "x", type: "string" as const, default: "dd" }], body: "echo hi" }];
    const { brain, fx } = await world({ scripts: wp });
    const r = await brain("run", "windows", "pw", "--plan");
    expect(r.out).toContain(scriptPlanId({ machine: "windows", name: "pw", platform: PLAT, sha256: fx.entry(wp[0]!).sha256, params: { x: "dd" } }));
    const o = await brain("run", "windows", "pw", "--param", "x=ee", "--plan");
    expect(o.out).toContain(scriptPlanId({ machine: "windows", name: "pw", platform: PLAT, sha256: fx.entry(wp[0]!).sha256, params: { x: "ee" } }));
  });
  it("write: --confirmed olmadan reddedilir (çıkış 1, 'approval'); doğru plan-id ile çalışır", async () => {
    const { brain, fx } = await world();
    const no = await brain("run", "windows", "mark-write");
    expect(no.code).toBe(1);
    expect(no.err).toContain("approval");
    expect(fx.lines("mark-write")).toEqual([]);
    const bad = await brain("run", "windows", "mark-write", "--confirmed", "0000000000000000");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("approval");
    const ok = await brain("run", "windows", "mark-write", "--confirmed", planOf(fx, "mark-write"), "--op-id", "cli-w-1");
    expect(ok.code, ok.err).toBe(0);
    expect(fx.lines("mark-write")).toEqual(["cli-w-1"]);
  });
  it("read sınıfında --confirmed yok sayılır (hatalı olsa da çalışır)", async () => {
    const { brain } = await world();
    expect((await brain("run", "windows", "mark-read", "--confirmed", "yanlis")).code).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("scripts CLI: geçici hatalar çıkış 75 (S17, S15)", () => {
  it("işçi Agent kapalı → unreachable → çıkış 75", async () => {
    const { brain, w: world_ } = await world();
    await world_.stopAgent("worker");
    const r = await brain("run", "windows", "mark-read");
    expect(r.code).toBe(75);
  });
  it("başka betik sürerken ikinci write → busy → çıkış 75; ilk bitince aynı opId ile çalışır", async () => {
    const { brain, fx } = await world();
    const first = brain("run", "windows", "hold", "--confirmed", planOf(fx, "hold"), "--op-id", "cli-h1");
    await until(() => fx.has(".started-hold"));
    const busy = await brain("run", "windows", "other-write", "--confirmed", planOf(fx, "other-write"), "--op-id", "cli-b1");
    expect(busy.code).toBe(75);
    expect(fx.lines("other-write")).toEqual([]);
    writeFileSync(join(fx.repo, ".release"), "");
    expect((await first).code).toBe(0);
    expect((await brain("run", "windows", "other-write", "--confirmed", planOf(fx, "other-write"), "--op-id", "cli-b1")).code).toBe(0);
    expect(fx.lines("other-write")).toEqual(["cli-b1"]);
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("scripts CLI: yetki — işçi ve konsol kimliği çalıştıramaz (S14)", () => {
  it("işçi tarafında `machine run|scripts` reddedilir (yalnız beyin)", async () => {
    const { w: world_, fx, wt } = await world();
    for (const argv of [["machine", "run", "windows", "mark-read"], ["machine", "scripts", "windows"]]) {
      const r = await runVlad(world_.worker, argv);
      expect(r.code, argv.join(" ")).not.toBe(0);
      expect(r.err, "işçide reddedilmeli, çalıştırılmaya çalışılmamalı").not.toContain("gerçeklenmedi");
    }
    expect(journal(wt.home).filter((r) => r.op === "script-run")).toEqual([]);
    expect(fx.lines("mark-read")).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("scripts KK8/S22: Agent çökmesi ve açılış uzlaştırması", () => {
  const restart = async (ww: World) => { await ww.stopAgent("worker"); await ww.startAgents(["worker"]); };
  it("read: betik koştu, günlük 'started' kaldı, Agent öldü → yeniden açılışta aynı opId yeniden koşar (not-applied)", async () => {
    const { brain, fx, w: ww, wt } = await world({ test: { VLAD_TEST_CRASH_AT: "after-apply" } });
    const r1 = await brain("run", "windows", "mark-read", "--op-id", "crash-r", "--json");
    expect(r1.code).not.toBe(0); // Agent işlem sonucunu yazmadan öldü
    expect(fx.lines("mark-read")).toEqual(["crash-r"]);
    expect(lastRec(wt.home, "crash-r")).toMatchObject({ state: "started", op: "script-run" });
    await restart(ww);
    const rec = lastRec(wt.home, "crash-r");
    expect(rec).toMatchObject({ state: "aborted" }); // uzlaştırma: read → not-applied
    const r2 = await brain("run", "windows", "mark-read", "--op-id", "crash-r", "--json");
    expect(r2.code, r2.err).toBe(0);
    expect(fx.lines("mark-read")).toEqual(["crash-r", "crash-r"]);
  }, 60_000);
  it("write: betik koştu, Agent öldü → yeniden açılışta kayıt done+uncertain; aynı opId betiği TEKRAR koşmaz, sonuç belirsiz bildirilir", async () => {
    const { brain, fx, w: ww, wt } = await world({ test: { VLAD_TEST_CRASH_AT: "after-apply" } });
    const id = planOf(fx, "mark-write");
    const r1 = await brain("run", "windows", "mark-write", "--confirmed", id, "--op-id", "crash-w", "--json");
    expect(r1.code).not.toBe(0);
    expect(fx.lines("mark-write")).toEqual(["crash-w"]);
    await restart(ww);
    expect(lastRec(wt.home, "crash-w")).toMatchObject({ state: "done", meta: { uncertain: true } });
    const r2 = await brain("run", "windows", "mark-write", "--confirmed", id, "--op-id", "crash-w", "--json");
    expect(JSON.stringify(r2.out + r2.err)).toContain("uncertain");
    expect(fx.lines("mark-write"), "write betiği yeniden koşmamalı").toEqual(["crash-w"]);
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("scripts S23 (b): selfUpdate başarısı — restart:scheduled, sonuç günlüğe işlenir, Agent kendini yeniden başlatır (POSIX: çıkış, launchd/systemd döndürür)", () => {
  it("self-ok (write, selfUpdate, exit 0, data.ok true) → restart 'scheduled'; yanıt gelir; Agent süreci sonra çıkar; aynı opId replay'de aynı sonuç", async () => {
    const { brain, fx, w: ww, wt } = await world();
    const proc = ww.agents.worker!.proc;
    const r = await brain("run", "windows", "self-ok", "--confirmed", planOf(fx, "self-ok"), "--op-id", "su-1", "--json");
    expect(r.code, r.err).toBe(0);
    expect(parse(r.out)).toMatchObject({ exit: 0, restart: "scheduled", data: { ok: true } });
    await until(() => proc.exitCode !== null || proc.signalCode !== null, 20_000);
    expect(lastRec(wt.home, "su-1")).toMatchObject({ state: "done" }); // sonuç yeniden başlamadan ÖNCE günlüğe işlendi
    await ww.stopAgent("worker");
    await ww.startAgents(["worker"]);
    const again = await brain("run", "windows", "self-ok", "--confirmed", planOf(fx, "self-ok"), "--op-id", "su-1", "--json");
    expect(again.code, again.err).toBe(0);
    expect(parse(again.out)).toMatchObject({ restart: "scheduled" });
    expect((await brain("ping", "windows")).code).toBe(0);
  }, 90_000);
});
