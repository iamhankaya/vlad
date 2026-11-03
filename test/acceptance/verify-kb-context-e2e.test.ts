// Doğrulama (T20261102-58): "kb bağlamı" çatısı (T20261102-55) — `kb refs` + özet tazeliği birlikte, uçtan uca.
// Gerçek `dist/cli.js`, geçici VLAD_HOME; kb biçimi gerçeğe yakın (arşiv, rapor bölümleri, bulgu, karar).
// Kabul kriterleri için bkz. çatı: refs listesi/commit/uyarı, çelişki işaretleri, status --summary bayat sayımı.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeFixtureRoot, makeHome } from "../helpers.js";
import { NO_CLOUD_ENV, root, vlad as run } from "./cloud-helpers.js";

let home: string;
// F-vlad-173: default config roots (C:\dev) would resolve the card-less project to the real C:\dev\vlad repo; isolate roots to an empty temp dir
beforeEach(() => { home = makeHome(); writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ roots: [makeFixtureRoot()] })); });

const vlad = (args: string[], input?: string) => run(home, args, { input, env: NO_CLOUD_ENV });
const json = <T = any>(args: string[], input?: string): T => {
  const r = vlad([...args, "--json"], input);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out) as T;
};
const kb = (...p: string[]) => join(home, "kb", ...p);
const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };

const card = (slug: string, path: string, status = "active") =>
  `---\nslug: ${slug}\nname: ${slug}\npath: ${JSON.stringify(path)}\nstack: [ts]\nstatus: ${status}\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`;
const task = (id: string, updated: string, body: string, o: { state?: string; project?: string; archive?: string } = {}) =>
  put(o.archive ? kb("tasks", "archive", o.archive, `${id}.md`) : kb("tasks", `${id}.md`),
    `---\nid: ${id}\nproject: ${o.project ?? "vlad"}\ntitle: t ${id}\nkind: dev\nstate: ${o.state ?? "done"}\nautonomy: commit\ncreated: "${updated}+00:00"\nupdated: "${updated}+00:00"\n---\n\n${body}`);
const finding = (id: string, state: string, updated: string, archive?: string) =>
  put(archive ? kb("findings", "archive", archive, `${id}.md`) : kb("findings", `${id}.md`),
    `---\nid: ${id}\nproject: vlad\ntitle: f ${id}\nseverity: yüksek\nstate: ${state}\nsource_task: T20261101-10\ncreated: "${updated}+00:00"\nupdated: "${updated}+00:00"\n---\n\nbulgu gövdesi\n`);
const report = (open: string, done = "- bir şey yapıldı") =>
  `## İlerleme\n- başladı\n\n## Kapanış raporu\n### Yapılanlar\n${done}\n\n### Açık noktalar\n${open}\n`;

function gitRepo(): { dir: string; git: (...a: string[]) => void } {
  const dir = makeFixtureRoot();
  const git = (...a: string[]) => { execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" }); };
  git("init", "-q");
  return { dir, git };
}

describe("kb refs uçtan uca (gerçek CLI)", { timeout: 60_000 }, () => {
  it("F-vlad-139 vakası: commit'te geçen açık bulgu, sonraki raporun Açık noktalar'ında → çelişki işareti (commit kanıtlı)", () => {
    const { dir, git } = gitRepo();
    writeFileSync(join(dir, "a"), "1"); git("add", "a");
    git("commit", "-q", "-m", "fix: F-vlad-139 ile ilgili düzeltme");
    writeFileSync(join(dir, "a"), "2"); git("commit", "-q", "-am", "fix: F-vlad-1390 başka bulgu"); // tam-token: karışmamalı
    put(kb("projects", "vlad.md"), card("vlad", dir));
    finding("F-vlad-139", "open", "2026-11-01T09:00:00");
    task("T20261101-10", "2026-11-01T09:00:00", report("- F-vlad-139 ilk kez burada açıldı")); // bulgunun doğduğu rapor
    task("T20261102-20", "2026-11-02T10:00:00", report("- F-vlad-139 hâlâ açık, commit düzeltmedi"));

    const r = json(["kb", "refs", "F-vlad-139"]);
    expect(r).toMatchObject({ id: "F-vlad-139", type: "finding", status: "open", project: "vlad" });
    expect(r.mentions.map((m: any) => [m.type, m.id, m.status, m.section])).toEqual([
      ["task", "T20261101-10", "done", "### Açık noktalar"],
      ["task", "T20261102-20", "done", "### Açık noktalar"],
    ]);
    expect(r.mentions.every((m: any) => typeof m.date === "string" && m.path && m.relative)).toBe(true);
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0].subject).toContain("F-vlad-139 ile ilgili");
    expect(r.warnings).toEqual([]);
    expect(r.flags.map((f: any) => f.code)).toEqual(["open_but_done_in_report"]);
    expect(r.flags[0].evidence.join("\n")).toMatch(/commit [0-9a-f]{8}/);

    const text = vlad(["kb", "refs", "F-vlad-139"]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toMatch(/ÇELİŞKİ/);
    expect(text.out).toContain("T20261102-20");
  });

  it("bulgu fixed ama son rapor Açık noktalar'da → işaret; doğum raporu (eski) işaretlenmez; arşivdeki kayıtlar dahil", () => {
    put(kb("projects", "vlad.md"), card("vlad", "/yok/boyle/yer"));
    finding("F-vlad-100", "fixed", "2026-10-25T09:00:00", "2026-10");           // arşivlenmiş bulgu
    task("T20261020-01", "2026-10-20T09:00:00", report("- F-vlad-100 bulundu"), { archive: "2026-10" }); // doğum raporu, arşivde, düzeltmeden eski
    expect(json(["kb", "refs", "F-vlad-100"]).flags).toEqual([]);
    task("T20261030-02", "2026-10-30T09:00:00", report("- F-vlad-100 yine görüldü"), { archive: "2026-10" });
    const r = json(["kb", "refs", "F-vlad-100"]);
    expect(r.status).toBe("fixed");
    expect(r.mentions.map((m: any) => m.id)).toEqual(["T20261020-01", "T20261030-02"]);
    expect(r.flags.map((f: any) => f.code)).toEqual(["fixed_but_open_in_report"]);
    expect(r.flags[0].evidence[0]).toContain("T20261030-02");
  });

  it("açık bulgu raporun Yapılanlar'ında geçiyorsa işaret; çelişkisiz kayıtta flags boş; karar atfı bölümle listelenir", () => {
    put(kb("projects", "vlad.md"), card("vlad", "/yok/boyle/yer"));
    finding("F-vlad-101", "open", "2026-11-01T09:00:00");
    task("T20261102-21", "2026-11-02T09:00:00", report("- yok", "- F-vlad-101 düzeltildi"));
    expect(json(["kb", "refs", "F-vlad-101"]).flags.map((f: any) => f.code)).toEqual(["open_but_done_in_report"]);

    finding("F-vlad-102", "open", "2026-11-01T09:00:00");
    task("T20261102-22", "2026-11-02T09:00:00", report("- F-vlad-102 devam"));
    expect(json(["kb", "refs", "F-vlad-102"]).flags).toEqual([]);

    put(kb("decisions", "vlad.md"), "");
    writeFileSync(kb("decisions", "vlad.md"), "");
    const add = vlad(["decision", "add", "--project", "vlad", "--title", "Ertele", "--body-file", "-", "--json"], "- **Karar:** F-vlad-102 ertelendi\n");
    expect(add.code, add.err).toBe(0);
    const id = JSON.parse(add.out).id as string;
    const r = json(["kb", "refs", "F-vlad-102"]);
    expect(r.mentions.map((m: any) => [m.type, m.id, m.status])).toContainEqual(["decision", id, "geçerli"]);
    // karar kimliğinin kendi atıfları
    task("T20261102-23", "2026-11-02T10:00:00", `## İlerleme\n- ${id} uygulandı\n`, { state: "running" });
    const d = json(["kb", "refs", id]);
    expect(d.type).toBe("decision");
    expect(d.mentions.map((m: any) => [m.id, m.status, m.section])).toEqual([["T20261102-23", "running", "## İlerleme"]]);
  });

  it("klon yoksa hata vermez (warnings); bilinmeyen ve bozuk ID standart hata biçimiyle 1 çıkar", () => {
    put(kb("projects", "vlad.md"), card("vlad", "/yok/boyle/yer"));
    finding("F-vlad-103", "open", "2026-11-01T09:00:00");
    const r = json(["kb", "refs", "F-vlad-103"]);
    expect(r.commits).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/klon bulunamadı/);
    for (const bad of ["F-vlad-999", "xyz"]) {
      const e = vlad(["kb", "refs", bad, "--json"]);
      expect(e.code).toBe(1);
      expect(JSON.parse(e.err).error).toMatch(/bulunamadı|geçersiz ID/);
    }
  });
});

describe("özet tazeliği uçtan uca (gerçek CLI)", { timeout: 60_000 }, () => {
  it("status --summary bayat/eksik özetleri adlandırır, digest pending ile birlikte satır 'yüksek bulgu' ile biter", () => {
    put(kb("projects", "vlad.md"), card("vlad", "/yok/a"));
    put(kb("projects", "yeni.md"), card("yeni", "/yok/b"));
    put(kb("projects", "eski.md"), card("eski", "/yok/c", "archived"));
    put(kb("projects", "dur.md"), card("dur", "/yok/d", "paused"));
    const sumFile = join(home, "ozet.md");
    writeFileSync(sumFile, "Özet metni.\n");
    expect(vlad(["project", "summary", "vlad", "--file", sumFile]).code).toBe(0);
    // özetten SONRA kayıtlar → vlad bayat
    task("T29990101-01", "2999-01-01T00:00:00", "## Tanım\nx\n", { state: "running" });
    finding("F-vlad-200", "open", "2999-01-01T00:00:00");
    expect(vlad(["digest", "pending", "add", "--text", "Belirsiz karar", "--project", "vlad"]).code).toBe(0);

    const s = json(["status", "--summary"]);
    expect(s.pendingDigest).toBe(1);
    const stale = Object.fromEntries(s.staleSummaries.map((x: any) => [x.slug, x]));
    expect(Object.keys(stale).sort()).toEqual(["vlad", "yeni"]); // archived + paused sayılmaz
    expect(stale.vlad.state).toBe("bayat");
    expect(stale.vlad.newer).toBeGreaterThanOrEqual(2);
    expect(stale.yeni).toMatchObject({ state: "yok", newer: 0 });

    // açık yüksek bulgu satır sonuna gelir; bayat parça ondan önce
    finding("F-vlad-201", "open", "2999-01-01T00:00:00");
    const line = vlad(["status", "--summary"]).out;
    expect(line).toMatch(/bayat\/eksik proje özeti: .*vlad \(\d+\+? kayıt\).*yeni \(özet yok\)/);
    expect(line).toContain("1 onay bekleyen digest maddesi");
    expect(line).toMatch(/, 2 açık kritik\/yüksek bulgu\s*$/);
    expect(vlad(["status", "--summary", "--hook"]).out).toContain("bayat/eksik proje özeti");
    // --no-mark aynı sayıları verir
    expect(json(["status", "--summary", "--no-mark"]).staleSummaries.map((x: any) => x.slug).sort()).toEqual(["vlad", "yeni"]);

    const p = vlad(["project", "status", "vlad", "--json"]);
    expect(p.code, p.err).toBe(0);
    expect(JSON.parse(p.out).summary.state).toBe("bayat"); // status --summary ile project status aynı kaynaktan
  });

  it("özetsiz/bayat proje yokken satırda bayat parçası görünmez", () => {
    put(kb("projects", "vlad.md"), card("vlad", "/yok/a", "paused"));
    const out = vlad(["status", "--summary"]).out;
    expect(out).not.toMatch(/bayat\/eksik/);
    expect(json(["status", "--summary"]).staleSummaries).toEqual([]);
  });
});

describe("iki özellik birlikte: bayat özetli projede refs çalışır ve skill metinleri bayat özeti /digest'e bağlar", { timeout: 60_000 }, () => {
  it("bayat proje için refs hata vermez; status/digest skill ve CLAUDE.md /digest önerisini içerir", () => {
    put(kb("projects", "vlad.md"), card("vlad", "/yok/a"));
    finding("F-vlad-300", "open", "2026-11-01T09:00:00");
    task("T20261102-30", "2026-11-02T09:00:00", report("- F-vlad-300"));
    expect(json(["status", "--summary"]).staleSummaries.map((x: any) => x.slug)).toEqual(["vlad"]);
    expect(json(["kb", "refs", "F-vlad-300"]).mentions).toHaveLength(1);

    const status = readFileSync(join(root, ".claude/skills/status/SKILL.md"), "utf8");
    expect(status).toMatch(/bayat/i);
    expect(status).toMatch(/\/digest/);
    expect(status).toMatch(/sabah raporu/i);
    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude).toMatch(/bayat\/eksik proje özeti/);
    expect(claude).toMatch(/kb commit\|check\|maintain\|get\|search\|refs/);
  });
});

describe("OS bağımsızlığı (statik kontrol)", () => {
  it("yeni kod yol ayracı/OS varsayımı içermez; git execFile ile çağrılır", () => {
    for (const f of ["src/kb/refs.ts", "src/digest/pending.ts", "src/projects/status.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/process\.platform|win32|["'`]\/tmp|C:\\\\|execSync\(/);
    }
    const git = readFileSync(join(root, "src/git/git.ts"), "utf8");
    expect(git).toMatch(/execFileSync/);
  });
});
