// Doğrulama (T20261022-61): "ekip iyileştirmeleri" beş adımının uçtan uca testleri.
// Gerçek `dist/cli.js`, geçici VLAD_HOME; yalnızca CLI arayüzü ve dosya sözleşmesi.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { resolveKbDir } from "../../src/kb/home.js";
import { NO_CLOUD_ENV, root, vlad as run, writeCard } from "./cloud-helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });

const vlad = (args: string[], input?: string) => run(home, args, { input, env: NO_CLOUD_ENV });
const json = <T = any>(args: string[], input?: string): T => {
  const r = vlad([...args, "--json"], input);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out) as T;
};
const errOf = (r: { code: number | null; err: string }) => {
  expect(r.code).toBe(1);
  return r.err;
};
const body = "## Tanım\nx\n";
const newTask = (args: string[] = []) =>
  json<{ id: string }>(["task", "new", "--project", "alpha", "--title", "T", "--body-file", "-", ...args], body).id;
const setState = (id: string, s: string) => expect(vlad(["task", "set", id, s]).code).toBe(0);

describe("adım 1: project set gate", { timeout: 30_000 }, () => {
  beforeEach(() => writeCard(home, "alpha"));

  it("yazar, project list --json gösterir, boş değer siler", () => {
    expect(json(["project", "set", "alpha", "gate", "npm test"])).toMatchObject({ slug: "alpha", field: "gate", value: "npm test" });
    expect(json(["project", "list"]).projects[0].gate).toBe("npm test");
    expect(vlad(["project", "list"]).out).toContain("npm test");
    expect(json(["project", "set", "alpha", "gate", ""]).value).toBeNull();
    expect(json(["project", "list"]).projects[0].gate ?? null).toBeNull();
  });
  it("kartın kalan alanlarını ve gövdesini korur; `project write` gate'i kabul eder", () => {
    vlad(["project", "set", "alpha", "gate", "npm run build && npm test"]);
    const card = readFileSync(join(home, "kb", "projects", "alpha.md"), "utf8");
    expect(card).toMatch(/^gate: /m);
    expect(card).toContain("## Özet\nx");
    expect(card).toContain("slug: alpha");
  });
  it("hata yolları: bilinmeyen alan ve kart, çıkış 1; --json'da {error,details} stderr'e", () => {
    expect(errOf(vlad(["project", "set", "alpha", "nope", "x"]))).toMatch(/bilinmeyen alan/);
    expect(errOf(vlad(["project", "set", "zzz", "gate", "x"]))).toMatch(/proje kartı bulunamadı/);
    const r = vlad(["project", "set", "zzz", "gate", "x", "--json"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(JSON.parse(r.err)).toMatchObject({ error: expect.stringMatching(/bulunamadı/), details: expect.any(Array) });
  });
  it("project note: tarihli madde, --file ve stdin", () => {
    expect(vlad(["project", "note", "alpha", "vitest önbelleği bayatlar"]).code).toBe(0);
    expect(vlad(["project", "note", "alpha", "--file", "-"], "ikinci\n").code).toBe(0);
    const card = readFileSync(join(home, "kb", "projects", "alpha.md"), "utf8");
    expect(card).toMatch(/## Çalışma notları\n- \d{4}-\d\d-\d\d: vitest önbelleği bayatlar\n- \d{4}-\d\d-\d\d: ikinci/);
    expect(card.indexOf("## Özet")).toBeLessThan(card.indexOf("## Çalışma notları"));
  });
});

describe("adım 2: finding add|list|set + status --summary", { timeout: 30_000 }, () => {
  beforeEach(() => writeCard(home, "alpha"));
  const add = (extra: string[], detail?: string) =>
    vlad(["finding", "add", "--project", "alpha", "--source", "T20261022-01", ...extra, "--json"], detail);

  it("tam yaşam döngüsü: add → list filtreleri → set fixed --by → dosya", () => {
    const a = JSON.parse(add(["--severity", "yüksek", "--title", "Bir", "--detail-file", "-"], "uzun ayrıntı\n").out);
    const b = JSON.parse(add(["--severity", "kritik", "--title", "İki", "--state", "deferred"]).out);
    const c = JSON.parse(add(["--severity", "düşük", "--title", "Üç"]).out);
    expect([a.id, b.id, c.id]).toEqual(["F-alpha-001", "F-alpha-002", "F-alpha-003"]);

    const all = json(["finding", "list"]).findings;
    expect(all.map((f: any) => f.id)).toEqual(["F-alpha-001", "F-alpha-002", "F-alpha-003"]);
    expect(all[0].detail).toContain("uzun ayrıntı");
    expect(json(["finding", "list", "--state", "deferred"]).findings.map((f: any) => f.id)).toEqual(["F-alpha-002"]);
    expect(json(["finding", "list", "--severity", "kritik,yüksek"]).findings).toHaveLength(2);
    expect(json(["finding", "list", "--project", "yok"]).findings).toEqual([]);

    expect(json(["finding", "set", a.id, "fixed", "--by", "T20261022-02"])).toMatchObject({ state: "fixed", fixed_by: "T20261022-02" });
    const file = readFileSync(join(home, "kb", "findings", `${a.id}.md`), "utf8");
    expect(file).toMatch(/^state: fixed$/m);
    expect(file).toMatch(/^fixed_by: T20261022-02$/m);
    expect(file).toContain("uzun ayrıntı");
    // yeniden açınca fixed alanları kalmaz
    expect(vlad(["finding", "set", a.id, "open"]).code).toBe(0);
    expect(readFileSync(join(home, "kb", "findings", `${a.id}.md`), "utf8")).not.toMatch(/fixed_by/);
  });
  it("ID'ler proje başına sayılır", () => {
    writeCard(home, "beta");
    add(["--severity", "orta", "--title", "a"]);
    const r = JSON.parse(vlad(["finding", "add", "--project", "beta", "--source", "T20261022-01", "--severity", "orta", "--title", "b", "--json"]).out);
    expect(r.id).toBe("F-beta-001");
  });
  it("status --summary yalnızca açık (open+deferred) kritik/yüksek sayısını ekler", () => {
    expect(vlad(["status", "--summary"]).out).not.toMatch(/bulgu/);
    add(["--severity", "kritik", "--title", "k"]);
    add(["--severity", "yüksek", "--title", "y", "--state", "deferred"]);
    add(["--severity", "orta", "--title", "o"]);
    expect(vlad(["status", "--summary"]).out).toMatch(/, 2 açık kritik\/yüksek bulgu\s*$/);
    expect(vlad(["status", "--summary", "--hook"]).out).toContain("2 açık kritik/yüksek bulgu");
    vlad(["finding", "set", "F-alpha-001", "wontfix"]);
    vlad(["finding", "set", "F-alpha-002", "fixed", "--by", "T20261022-03"]);
    expect(vlad(["status", "--summary"]).out).not.toMatch(/bulgu/);
  });
  it("hata yolları ve standart hata biçimi", () => {
    add(["--severity", "orta", "--title", "x"]);
    expect(errOf(vlad(["finding", "add", "--project", "alpha", "--source", "T20261022-01", "--severity", "foo", "--title", "x"]))).toMatch(/geçersiz önem/);
    expect(errOf(vlad(["finding", "add", "--project", "alpha", "--source", "T20261022-01", "--severity", "orta", "--title", "x", "--state", "fixed"]))).toMatch(/open\|deferred/);
    expect(errOf(vlad(["finding", "add", "--project", "alpha", "--severity", "orta", "--title", "x"]))).toMatch(/--source/);
    expect(errOf(vlad(["finding", "list", "--state", "bogus"]))).toMatch(/geçersiz durum/);
    expect(errOf(vlad(["finding", "set", "F-alpha-001", "bogus"]))).toMatch(/geçersiz durum/);
    expect(errOf(vlad(["finding", "set", "F-alpha-001", "open", "--by", "T20261022-01"]))).toMatch(/yalnızca fixed/);
    expect(errOf(vlad(["finding", "set", "F-alpha-099", "fixed"]))).toMatch(/bulgu bulunamadı/);
    // şema ihlali (bozuk source) --json'da {error, details[]}
    const r = vlad(["finding", "add", "--project", "alpha", "--source", "kötü", "--severity", "orta", "--title", "x", "--json"]);
    expect(r.code).toBe(1);
    const e = JSON.parse(r.err);
    expect(e.error).toMatch(/doğrulama hatası/);
    expect(e.details.length).toBeGreaterThan(0);
    // başarısız add dosya bırakmaz
    expect(readdirSync(join(home, "kb", "findings"))).toEqual(["F-alpha-001.md"]);
  });
  it("paralel add'ler çakışmaz (aynı ID iki kez verilmez)", () => {
    const procs = Array.from({ length: 4 }, (_, i) =>
      add(["--severity", "orta", "--title", `p${i}`]));
    const ids = procs.map((r) => JSON.parse(r.out).id);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("adım 3: maxParallel + task ready + resume", { timeout: 30_000 }, () => {
  const cfg = (c: object) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify(c));
  const phase = (parent: string, title: string, extra: string[] = []) => newTask(["--parent", parent, "--phase", title, ...extra]);
  let pid: string, a: string, b: string, c: string;
  beforeEach(() => {
    pid = newTask(["--kind", "pipeline"]);
    a = phase(pid, "spec");
    b = phase(pid, "plan", ["--depends-on", a]);
    c = phase(pid, "kabul");
  });

  it("maxParallel yok: tüm hazır fazlar tasks'ta, held_by_limit boş, maxParallel null", () => {
    const r = json(["task", "ready", "--parent", pid]);
    expect(r.tasks.map((t: any) => t.id)).toEqual([a, c]);
    expect(r).toMatchObject({ held_by_limit: [], running: 0, maxParallel: null });
  });
  it("maxParallel=1: ilk hazır faz tasks'ta, kalan held_by_limit'te; running sayısı hesaba girer", () => {
    cfg({ maxParallel: 1 });
    let r = json(["task", "ready", "--parent", pid]);
    expect(r.tasks.map((t: any) => t.id)).toEqual([a]);
    expect(r.held_by_limit.map((t: any) => t.id)).toEqual([c]);
    expect(r).toMatchObject({ running: 0, maxParallel: 1 });
    setState(a, "running");
    r = json(["task", "ready", "--parent", pid]);
    expect(r.tasks).toEqual([]);
    expect(r.held_by_limit.map((t: any) => t.id)).toEqual([c]);
    expect(r.running).toBe(1);
    // bağımlılığı done olan faz hazır olur; limit yine uygulanır
    setState(a, "awaiting_approval"); setState(a, "done");
    r = json(["task", "ready", "--parent", pid]);
    expect(r.tasks.map((t: any) => t.id)).toEqual([b]);
    expect(r.held_by_limit.map((t: any) => t.id)).toEqual([c]);
  });
  it("maxParallel=2 iki fazı birden verir", () => {
    cfg({ maxParallel: 2 });
    expect(json(["task", "ready", "--parent", pid]).tasks).toHaveLength(2);
  });
  it("geçersiz maxParallel (0, 1.5, 'x') standart hata biçimiyle reddedilir", () => {
    for (const v of [0, 1.5, "x", -1]) {
      cfg({ maxParallel: v });
      const r = vlad(["task", "ready", "--json"]);
      expect(r.code, String(v)).toBe(1);
      expect(JSON.parse(r.err).error).toMatch(/maxParallel/);
    }
  });
  it("düz (--json'suz) task ready çıktısı hazır görevleri listeler", () => {
    const out = vlad(["task", "ready", "--parent", pid]).out;
    expect(out).toContain(a);
    expect(out).not.toContain(b);
  });

  describe("task resume", () => {
    it("queued/done/awaiting_approval görev sürdürülemez", () => {
      expect(errOf(vlad(["task", "resume", a]))).toMatch(/yalnızca running\/stalled/);
      expect(errOf(vlad(["task", "resume", "T20261022-77"]))).toMatch(/görev bulunamadı/);
    });
    it("running ama ne worktree ne session_id: açık hata, --json'da {error,details}", () => {
      setState(a, "running");
      const r = vlad(["task", "resume", a, "--json"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.err).error).toMatch(/sürdürülemez/);
    });
    it("bulut: session_id kayıtlıysa send_message argümanları verir (stalled dahil)", () => {
      setState(a, "running");
      expect(vlad(["task", "session", a, "session_abc"]).code).toBe(0);
      const r = json(["task", "resume", a]);
      expect(r).toMatchObject({ id: a, mode: "cloud", action: "send_message", session_id: "session_abc" });
      expect(r.args.session_id).toBe("session_abc");
      expect(r.args.message).toContain(`vlad/${a}`);
      setState(a, "stalled");
      expect(json(["task", "resume", a]).mode).toBe("cloud");
    });
    it("yerel: worktree + doğru branch → prompt ve kirli yollar; yanlış branch / silinmiş worktree hata", () => {
      const repo = mkdtempSync(join(tmpdir(), "vlad-resume-"));
      const git = (...x: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...x], { cwd: repo, stdio: "pipe" }).toString();
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "1");
      git("add", "."); git("commit", "-q", "-m", "i");
      git("checkout", "-q", "-b", `vlad/${a}`);
      setState(a, "running");
      // worktree alanı yalnızca launch yazar; görev dosyasına doğrudan yazılır (mevcut testlerin yolu)
      const f = join(home, "kb", "tasks", `${a}.md`);
      const orig = readFileSync(f, "utf8");
      writeFileSync(f, orig.replace(/^worktree: .*$/m, `worktree: ${JSON.stringify(repo)}`));
      writeFileSync(join(repo, "wip.txt"), "x");
      const r = json(["task", "resume", a]);
      expect(r).toMatchObject({ mode: "local", branch: `vlad/${a}` });
      expect(r.dirty).toContain("wip.txt");
      expect(r.prompt).toContain(a);
      git("checkout", "-q", "main");
      expect(errOf(vlad(["task", "resume", a]))).toMatch(/yanlış branch/);
    });
  });
});

describe("geriye uyumluluk: gerçek kb salt-okuma (kopya üzerinde)", { timeout: 30_000 }, () => {
  // repodaki kb/ yalnızca okunur: `status` eski running'leri stalled'a yazabildiği için kopyada çalışılır
  const realKb = resolveKbDir(root).dir;
  const copy = () => {
    const h = mkdtempSync(join(tmpdir(), "vlad-realkb-"));
    cpSync(realKb, join(h, "kb"), { recursive: true });
    cpSync(join(root, "schemas"), join(h, "schemas"), { recursive: true });
    cpSync(join(root, "roles"), join(h, "roles"), { recursive: true });
    if (existsSync(join(root, "vlad.config.json"))) {
      // the copy holds its own kb/, so the committed external kbDir must not apply
      const { kbDir: _kbDir, ...cfg } = JSON.parse(readFileSync(join(root, "vlad.config.json"), "utf8"));
      writeFileSync(join(h, "vlad.config.json"), JSON.stringify(cfg));
    }
    return h;
  };
  const real = (h: string, args: string[]) => run(h, args, { env: NO_CLOUD_ENV });

  it.skipIf(!existsSync(realKb))("project list / task list / status / finding list / task ready / role list: çıkış 0, stderr boş, JSON geçerli", () => {
    const h = copy();
    for (const args of [
      ["project", "list", "--json"], ["task", "list", "--json"], ["status", "--json"], ["status", "--summary"],
      ["finding", "list", "--json"], ["task", "ready", "--json"], ["inbox", "count"], ["role", "list", "--json"],
    ]) {
      const r = real(h, args);
      expect(r.code, `${args.join(" ")}: ${r.err}`).toBe(0);
      expect(r.err, args.join(" ")).toBe("");
      if (args.includes("--json")) expect(() => JSON.parse(r.out), args.join(" ")).not.toThrow();
    }
  });
  it.skipIf(!existsSync(realKb))("her kart ve her görev dosyası yeni şemalarla uyarısız yüklenir (warnings boş)", () => {
    const h = copy();
    const p = JSON.parse(real(h, ["project", "list", "--json"]).out);
    expect(p.warnings).toEqual([]);
    expect(p.projects.length).toBe(readdirSync(join(h, "kb", "projects")).filter((n) => n.endsWith(".md")).length);
    const t = JSON.parse(real(h, ["task", "list", "--json"]).out);
    expect(t.warnings ?? []).toEqual([]);
    expect(t.tasks.length).toBe(readdirSync(join(h, "kb", "tasks")).filter((n) => n.endsWith(".md")).length);
  });
  it.skipIf(!existsSync(realKb))("gerçek kb'de gate/bulgu alanı olmayan eski kartlar gate=null olarak listelenir", () => {
    const p = JSON.parse(real(copy(), ["project", "list", "--json"]).out).projects;
    for (const c of p) expect(c.gate === undefined || c.gate === null || typeof c.gate === "string").toBe(true);
  });
});

describe("doküman tutarlılığı (makinece denetlenebilenler)", () => {
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  const help = (args: string[]) => run(home, [...args, "--help"], { env: NO_CLOUD_ENV }).out;

  it("CLAUDE.md komut listesi, `vlad --help` komutlarıyla birebir örtüşür", () => {
    const line = read("CLAUDE.md").split("\n").find((l) => l.startsWith("Kullanılabilir komutlar:"))!;
    const documented = new Set<string>();
    for (const m of line.matchAll(/`vlad ([a-z]+)(?: ((?:[a-z]+\|?)+))?/g)) {
      const subs = (m[2] ?? "").split("|").filter(Boolean);
      if (!subs.length) documented.add(m[1]);
      for (const s of subs) documented.add(`${m[1]} ${s}`);
    }
    const actual = new Set<string>();
    const top = [...help([]).matchAll(/^  ([a-z]+)\b/gm)].map((m) => m[1]).filter((c) => c !== "help");
    for (const c of top) {
      const sub = [...help([c]).split("Commands:")[1]?.matchAll(/^  ([a-z]+)\b/gm) ?? []].map((m) => m[1]).filter((s) => s !== "help");
      if (!sub.length) actual.add(c); else for (const s of sub) actual.add(`${c} ${s}`);
    }
    expect([...actual].filter((c) => !documented.has(c)), "CLI'da olup CLAUDE.md'de olmayan").toEqual([]);
    expect([...documented].filter((c) => !actual.has(c)), "CLAUDE.md'de olup CLI'da olmayan").toEqual([]);
  });
  it("CLAUDE.md `project set` alan listesi, CLI'ın kabul ettiği alanlarla aynı", () => {
    const m = /`set` alanları: ([^—)]*)/.exec(read("CLAUDE.md"))![1];
    const doc = m.split(",").map((x) => x.replace(/[`\s]/g, ""));
    const cli = /\(([a-z_|]+)\); boş/.exec(help(["project", "set"]).replace(/\s+/g, " "))![1].split("|");
    for (const f of cli) expect(doc, f).toContain(f);
  });
  it("her faz adı için ya bir rol çıktısı ya spec satırı vardır; roller kind'ı CLAUDE.md'deki gruplarla uyuşur", () => {
    const claude = read("CLAUDE.md");
    const advisory = ["finans", "pazarlama", "growth", "analyst", "architect"];
    const executor = ["developer", "tester", "designer", "devops", "game-developer", "game-director"];
    for (const r of advisory) expect(read(`roles/${r}.md`), r).toMatch(/^kind: advisory$/m);
    for (const r of executor) expect(read(`roles/${r}.md`), r).toMatch(/^kind: executor$/m);
    for (const r of [...advisory, ...executor]) expect(claude, r).toContain(r);
    expect(readdirSync(join(root, "roles")).length).toBe(advisory.length + executor.length);
  });
  it("her rolün `## Çıktı` bölümü var; kapanış raporu başlıkları `###`", () => {
    for (const f of readdirSync(join(root, "roles"))) {
      const t = read(`roles/${f}`);
      expect(t, f).toMatch(/^## Çıktı$/m);
      const out = t.split(/^## Çıktı$/m)[1];
      expect(out, f).toMatch(/`###/);
    }
  });
});
