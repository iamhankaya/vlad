// Doğrulama (2) (T20261022-63): düzeltme turunun (T20261022-62) uçtan uca doğrulaması — BUG-1 (3 haneli ID),
// BUG-3 (bulut prompt'u gate + entegrasyon öncesi kontrol, olumsuz durumlar), BUG-5 (kartsız proje).
// Hepsi gerçek derlenmiş CLI (dist/cli.js) ve geçici VLAD_HOME üzerinde koşar.
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { CLOUD_ENV, NO_CLOUD_ENV, assistantEvent, forceRunning, jsonl, newTask, taskFile, taskState, vlad as run, writeCard, writeRoles } from "./cloud-helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });
const vlad = (args: string[], input?: string, env: Record<string, string | undefined> = NO_CLOUD_ENV) => run(home, args, { input, env });
const json = (args: string[], input?: string, env?: Record<string, string | undefined>) => {
  const r = vlad(args, input, env);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out);
};
const ymd = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; };

/** Günün sayacını 99'a getirir: gerçek bir görev yazar, dosyasını -99 kimliğiyle kopyalar (geçerli frontmatter). */
function bumpCounterTo99(): void {
  writeCard(home, "alpha", { repo: "iamhankaya/vlad" });
  const seed = newTask(home);
  const src = taskFile(home, seed);
  const dst = join(home, "kb", "tasks", `T${ymd()}-99.md`);
  copyFileSync(src, dst);
  writeFileSync(dst, readFileSync(dst, "utf8").split(seed).join(`T${ymd()}-99`));
}

describe("BUG-1 uçtan uca: 3 haneli görev ID'leri", () => {
  beforeEach(bumpCounterTo99);

  it("task new → -100; task list ve task show/log onu tanır", () => {
    const id = newTask(home);
    expect(id).toBe(`T${ymd()}-100`);
    const list = json(["task", "list", "--json"]).tasks as { id: string }[];
    expect(list.map((t) => t.id)).toContain(id);
    expect(vlad(["task", "log", id, "adım", "--json"]).code).toBe(0);
  });

  it("pipeline: çatı -100, fazlar -101/-102; task ready 3 haneli depends_on/parent ile çalışır", () => {
    const parent = json(["task", "new", "--project", "alpha", "--title", "P", "--kind", "pipeline", "--json"]).id as string;
    expect(parent).toBe(`T${ymd()}-100`);
    const a = newTask(home, ["--parent", parent, "--phase", "spec"]);
    const b = newTask(home, ["--parent", parent, "--phase", "kabul", "--depends-on", a]);
    expect([a, b]).toEqual([`T${ymd()}-101`, `T${ymd()}-102`]);
    const ready = json(["task", "ready", "--parent", parent, "--json"]).tasks as { id: string }[];
    expect(ready.map((t) => t.id)).toEqual([a]);
  });

  it("finding add --source 3 haneli ID kabul eder; finding kaydı source_task'ı korur; fixed_by da 3 haneli olabilir", () => {
    const id = newTask(home);
    const f = json(["finding", "add", "--project", "alpha", "--source", id, "--severity", "orta", "--title", "x", "--json"]);
    expect(f.id).toBe("F-alpha-001");
    const file = readFileSync(join(home, "kb", "findings", `${f.id}.md`), "utf8");
    expect(file).toContain(id);
    expect(vlad(["finding", "set", f.id, "fixed", "--by", id, "--json"]).code).toBe(0);
  });

  it("ingest 3 haneli görevde: LOG işlenir, REPORT → awaiting_approval", () => {
    const id = newTask(home);
    forceRunning(home, id);
    const sha = "b".repeat(40);
    const events = join(home, "ev.jsonl");
    writeFileSync(events, jsonl([
      assistantEvent("[VLAD:LOG #1] adım"),
      assistantEvent(`[VLAD:REPORT #2 branch=vlad/${id} head=${sha}]\n### Yapılanlar\nx\n[VLAD:END #2]`),
    ]));
    const r = vlad(["task", "ingest", id, "--events-file", events, "--remote-head", sha, "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(taskState(home, id)).toBe("awaiting_approval");
  });

  it("4 haneli (-1000) ID de şemadan geçer", () => {
    writeFileSync(join(home, "kb", "tasks", `T${ymd()}-999.md`), readFileSync(join(home, "kb", "tasks", `T${ymd()}-99.md`), "utf8").split(`T${ymd()}-99`).join(`T${ymd()}-999`));
    expect(newTask(home)).toBe(`T${ymd()}-1000`);
  });

  it("1 haneli veya tarihsiz ID hâlâ reddedilir", () => {
    const r = vlad(["task", "log", `T${ymd()}-1`, "x", "--json"]);
    expect(r.code).toBe(1);
  });
});

describe.runIf(process.platform === "linux")("BUG-3 uçtan uca: gerçek `task launch --json` bulut prompt'u", () => {
  const launch = (extra: string[] = [], card: Record<string, string> = {}) => {
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "cloud" }));
    writeRoles(home);
    writeCard(home, "alpha", { repo: "iamhankaya/vlad", ...card });
    const id = newTask(home, ["--role", "tester", ...extra]);
    const r = vlad(["task", "launch", id, "--json"], undefined, CLOUD_ENV);
    expect(r.code, r.err).toBe(0);
    return JSON.parse(r.out).prompt as string;
  };
  const newParent = () => json(["task", "new", "--project", "alpha", "--title", "P", "--kind", "pipeline", "--json"]).id as string;

  it("gate + pipeline fazı: `## Proje kapısı` ve `## Entegrasyon öncesi kontrol` ikisi de, doğru içerikle", () => {
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "cloud" }));
    writeRoles(home);
    writeCard(home, "alpha", { repo: "iamhankaya/vlad", gate: '"npm run build && npm test"' });
    const parent = newParent();
    const phase = newTask(home, ["--role", "tester", "--parent", parent, "--phase", "kabul"]);
    const r = vlad(["task", "launch", phase, "--json"], undefined, CLOUD_ENV);
    expect(r.code, r.err).toBe(0);
    const p = JSON.parse(r.out).prompt as string;
    expect(p).toContain("## Proje kapısı");
    expect(p).toContain("`npm run build && npm test`");
    expect(p).toContain("### Test sonuçları");
    expect(p).toContain("## Entegrasyon öncesi kontrol");
    expect(p).toContain(`git fetch origin vlad/${parent}`);
    expect(p).toContain(`git merge vlad/${parent}`);
    expect(p).toMatch(/lint/);
    expect(p).toMatch(/[Çç]akışma/);
    // sıra: kapı ve kontrol protokolden önce gelir (protokol tek doğru kaynak olarak sonda)
    expect(p.indexOf("## Proje kapısı")).toBeLessThan(p.indexOf("## VLAD bulut protokolü"));
    expect(p.indexOf("## Entegrasyon öncesi kontrol")).toBeLessThan(p.indexOf("## VLAD bulut protokolü"));
  });

  it("gate yok + parent yok: ikisi de eklenmez", () => {
    const p = launch();
    expect(p).not.toContain("## Proje kapısı");
    expect(p).not.toContain("## Entegrasyon öncesi kontrol");
    expect(p).not.toMatch(/git merge vlad\//);
  });

  it("yalnız gate (parent yok): kapı var, entegrasyon kontrolü yok", () => {
    const p = launch([], { gate: '"npm test"' });
    expect(p).toContain("## Proje kapısı");
    expect(p).not.toContain("## Entegrasyon öncesi kontrol");
  });

  it("yalnız parent (gate yok): entegrasyon kontrolü var, kapı bölümü yok", () => {
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "cloud" }));
    writeRoles(home);
    writeCard(home, "alpha", { repo: "iamhankaya/vlad" });
    const parent = newParent();
    const phase = newTask(home, ["--role", "tester", "--parent", parent, "--phase", "kabul"]);
    const p = JSON.parse(vlad(["task", "launch", phase, "--json"], undefined, CLOUD_ENV).out).prompt as string;
    expect(p).toContain("## Entegrasyon öncesi kontrol");
    expect(p).not.toContain("## Proje kapısı");
  });

  it("3 haneli çatı ID'si prompt'ta tam yazılır (git merge vlad/T…-100)", () => {
    bumpCounterTo99();
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "cloud" }));
    writeRoles(home);
    const parent = newParent();
    expect(parent).toBe(`T${ymd()}-100`);
    const phase = newTask(home, ["--role", "tester", "--parent", parent, "--phase", "kabul"]);
    const p = JSON.parse(vlad(["task", "launch", phase, "--json"], undefined, CLOUD_ENV).out).prompt as string;
    expect(p).toContain(`git merge vlad/${parent}`);
  });
});

describe("BUG-5 uçtan uca: kartsız proje reddi", () => {
  const add = (project: string) =>
    vlad(["finding", "add", "--project", project, "--source", `T${ymd()}-01`, "--severity", "orta", "--title", "x", "--json"]);

  it("hata stderr'de {error, ...} JSON'u, kod 1, stdout boş, bulgu dosyası yazılmaz", () => {
    const r = add("yok-boyle-proje");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    const e = JSON.parse(r.err);
    expect(e.error).toBe("proje kartı bulunamadı: yok-boyle-proje");
    const dir = join(home, "kb", "findings");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("--json'suz da kod 1 ve okunur hata mesajı", () => {
    const r = vlad(["finding", "add", "--project", "yok", "--source", `T${ymd()}-01`, "--severity", "orta", "--title", "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/proje kartı bulunamadı: yok/);
  });

  it("kart eklenince aynı komut başarılı olur (reddin tek nedeni kart)", () => {
    expect(add("alpha").code).toBe(1);
    writeCard(home, "alpha");
    expect(add("alpha").code).toBe(0);
  });

  it("proje set / note aynı mesajla reddedilir (tutarlılık)", () => {
    for (const a of [["project", "set", "yok", "gate", "npm test"], ["project", "note", "yok", "ders"]]) {
      const r = vlad([...a, "--json"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/yok/);
    }
  });

  it("tireyle başlayan project set değeri `--` ile kabul edilir", () => {
    writeCard(home, "alpha");
    expect(vlad(["project", "set", "--json", "alpha", "gate", "--", "- a"]).code).toBe(0);
    expect(readFileSync(join(home, "kb", "projects", "alpha.md"), "utf8")).toContain("- a");
  });
});
