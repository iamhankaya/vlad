// Doğrulama (T20261022-61): bulunan hatalar için KASITLI KIRMIZI testler (rapor: "Kırmızı bırakılan testler").
// Düzeltme Developer görevine önerilir; test yeşile döndüğünde dosya normal suite'e dahildir.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { NO_CLOUD_ENV, CLOUD_ENV, root, vlad as run, writeCard, writeRoles } from "./cloud-helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });
const vlad = (args: string[], input?: string, env: Record<string, string | undefined> = NO_CLOUD_ENV) => run(home, args, { input, env });
const read = (p: string) => readFileSync(join(root, p), "utf8");
const ymd = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; };

describe("BUG-1: günün 100. görevi şemaya takılır", { timeout: 30_000 }, () => {
  it("T<gün>-99 varken `task new` T<gün>-100 üretir ve başarılı olur", () => {
    writeFileSync(join(home, "kb", "tasks", `T${ymd()}-99.md`), "x");
    const r = vlad(["task", "new", "--project", "alpha", "--title", "T", "--body-file", "-", "--json"], "## Tanım\nx\n");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).id).toBe(`T${ymd()}-100`);
  });
  it("finding add 3 haneli görev ID'sini kaynak olarak kabul eder", () => {
    writeCard(home, "alpha");
    const r = vlad(["finding", "add", "--project", "alpha", "--source", `T${ymd()}-100`, "--severity", "orta", "--title", "x", "--json"]);
    expect(r.code, r.err).toBe(0);
  });
});

describe("BUG-2: `task new --phase` yardımı yeni faz adlarını saymıyor", () => {
  it("yardım metni sözleşme, karakterizasyon, tasarım, denetim, prova ve danışma adlarını içerir", () => {
    const help = vlad(["task", "new", "--help"]).out.replace(/\s+/g, " ");
    for (const p of ["sözleşme", "karakterizasyon", "tasarım", "denetim", "prova", "danışma"]) expect(help, p).toContain(p);
  });
});

describe("BUG-3: bulut prompt'u kartın `gate` komutunu ve entegrasyon öncesi kontrolü taşımıyor", { timeout: 30_000 }, () => {
  beforeEach(() => {
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "cloud" }));
    writeRoles(home);
    writeCard(home, "alpha", { repo: "iamhankaya/vlad", gate: '"npm run build && npm test"' });
  });
  const prompt = (args: string[] = []) => {
    const id = JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "T", "--role", "tester", "--body-file", "-", ...args, "--json"], "## Tanım\nBulut\n", CLOUD_ENV).out).id;
    const r = vlad(["task", "launch", id, "--json"], undefined, CLOUD_ENV);
    expect(r.code, r.err).toBe(0);
    return JSON.parse(r.out).prompt as string;
  };
  it("kartta gate varsa prompt rapordan önce koşulacak komutu içerir (bulut çalışanı kb/ okuyamaz)", () => {
    expect(prompt()).toContain("npm run build && npm test");
  });
  it("pipeline fazında prompt entegrasyon branch'ini (vlad/<çatı>) rapordan önce merge etme kuralını içerir", () => {
    const pid = JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "P", "--kind", "pipeline", "--body-file", "-", "--json"], "## Tanım\nx\n", CLOUD_ENV).out).id;
    const p = prompt(["--parent", pid, "--phase", "kabul"]);
    expect(p).toContain(`git merge vlad/${pid}`);
  });
});

describe("BUG-4: pipeline spec `phase` alan listesi `karakterizasyon` adını saymıyor", () => {
  it("delegate skill'indeki faz adları spec'teki phase listesinin üst kümesi değil, aynısıdır", () => {
    const list = (s: string, re: RegExp) => new Set(re.exec(s)![1].match(/`([^`]+)`/g)!.map((x) => x.replace(/`/g, "")));
    const d = list(read(".claude/skills/delegate/SKILL.md"), /Faz adları: ([^.]*)\./);
    const s = list(read("docs/superpowers/specs/2026-10-16-vlad-pipeline-design.md"), /`phase: string \| null` — [^(]*\(([^)]*)\)/);
    expect([...d].sort()).toEqual([...s].sort());
  });
});

describe("BUG-5: finding add olmayan projeye bulgu yazıyor", { timeout: 30_000 }, () => {
  it("kartı olmayan proje için `finding add` hata verir (project set/note ile aynı davranış)", () => {
    mkdirSync(join(home, "kb", "findings"), { recursive: true });
    const r = vlad(["finding", "add", "--project", "yok-boyle-proje", "--source", `T${ymd()}-01`, "--severity", "orta", "--title", "x", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/proje kartı bulunamadı/);
  });
});
