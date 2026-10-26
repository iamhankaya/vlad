// Doğrulama fazı (T20261026-23): bulut çalışana kb salt okuma — faz 1 (cloud.ts readonly), faz 2 (kb check, skill, izin)
// ve uygulama 3 (güvenlik sertleştirmesi) birleşik uçtan uca. Yalnızca CLI / dışa açık arayüz; geçici kb ve geçici
// git depoları. Gerçek launcher, gerçek bulut session'ı ve ağ yok (pipeline fazında remoteBranch saplanır).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prepareCloudLaunch } from "../../src/tasks/cloud.js";
import { makeHome } from "../helpers.js";
import { CLOUD_ENV, build, forceRunning, newTask, readTask, taskFile, taskState, vlad, writeCard, writeRoles } from "./cloud-helpers.js";

const root = join(import.meta.dirname, "..", "..");
const BODY = "GOREV-METNI-ISARETI";
const NOTE = "CALISMA-NOTU-ISARETI";
const DEP_REPORT = "BAGIMLI-RAPOR-ISARETI";
const GATE = "npm run gate-isareti";

let home: string;
beforeAll(build, 120000);
beforeEach(() => {
  home = makeHome();
  writeRoles(home);
  writeCard(home, "alpha", { repo: "iamhankaya/vlad", gate: `"${GATE}"` });
  expect(vlad(home, ["project", "note", "alpha", NOTE]).code).toBe(0);
});

const cfg = (o: object) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "cloud", ...o }));
const launchCli = (id: string) => vlad(home, ["task", "launch", id, "--json"], { env: CLOUD_ENV });
const mk = (args: string[] = []) => newTask(home, ["--role", "tester", ...args], `## Tanım\n${BODY}\n`);

/** Çatı + rapor yazmış bağımlı faz + başlatılacak faz. */
function pipeline() {
  const parent = JSON.parse(vlad(home, ["task", "new", "--project", "alpha", "--title", "P", "--kind", "pipeline", "--body-file", "-", "--json"], { input: `## Tanım\nCATI-METNI-ISARETI\n` }).out).id as string;
  const dep = mk(["--parent", parent, "--phase", "spec"]);
  forceRunning(home, dep);
  const f = join(home, "dep.md");
  writeFileSync(f, `### Yapılanlar\n- ${DEP_REPORT}\n`);
  expect(vlad(home, ["task", "report", dep, "--file", f]).code).toBe(0);
  const phase = mk(["--parent", parent, "--phase", "kabul", "--depends-on", dep]);
  return { parent, dep, phase };
}

describe("launch (cloudKb: readonly): CLI uçtan uca", { timeout: 60_000 }, () => {
  it("cloudKb: readonly açıkça verilince: görev/not/gate prompt'ta yok, açılış adımları var, yalnız add_repo izni, kb push adımı create_session'dan önce", () => {
    cfg({ cloudKb: "readonly" });
    const id = mk();
    const r = launchCli(id);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ id, mode: "cloud", action: "create_session", state: "running", kb_access: "readonly", model: "sonnet" });
    expect(j.extra_allowed_tools).toEqual(["mcp__claude-code-remote__add_repo"]);
    for (const m of [BODY, NOTE, GATE]) expect(j.prompt, m).not.toContain(m);
    for (const m of [id, `tasks/${id}.md`, "iamhankaya", "vlad-kb", "RolGovdesiMarker", "[VLAD:REPORT", "salt okuma", "kb erişimi yok"]) {
      expect(j.prompt, m).toContain(m);
    }
    expect(j.prompt).not.toContain("register_repo_root");
    expect(Buffer.byteLength(j.prompt)).toBeLessThan(15 * 1024);
    const push = j.next.findIndex((n: string) => n.includes("vlad kb commit"));
    const create = j.next.findIndex((n: string) => n.startsWith("create_session("));
    expect(push).toBeGreaterThanOrEqual(0);
    expect(push).toBeLessThan(create);
    expect(j.next[create]).toContain("extra_allowed_tools");
    expect(taskState(home, id)).toBe("running");
  });

  it("kip yazılmamışsa inline (F-vlad-078): kb_access inline, izin yok", () => {
    cfg({});
    const j = JSON.parse(launchCli(mk()).out);
    expect(j.kb_access).toBe("inline");
    expect(j.extra_allowed_tools).toEqual([]);
    expect(j.prompt).toContain(BODY);
  });

  it("cloudKb: inline eski çıktıyı verir: görev, not ve gate satır içi, izin yok, kb push adımı yok", () => {
    cfg({ cloudKb: "inline" });
    const id = mk();
    const r = launchCli(id);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.kb_access).toBe("inline");
    expect(j.extra_allowed_tools).toEqual([]);
    for (const m of [BODY, NOTE, GATE]) expect(j.prompt, m).toContain(m);
    expect(j.prompt).not.toContain("add_repo");
    expect(j.next.join("\n")).not.toContain("vlad kb commit");
    expect(j.next.find((n: string) => n.startsWith("create_session("))).not.toContain("extra_allowed_tools");
  });

  it("geçersiz cloudKb değeri: çıkış 1, görev queued kalır ve error yazılır", () => {
    cfg({ cloudKb: "readonly" });
    const id = mk();
    cfg({ cloudKb: "yazilabilir" });
    const r = launchCli(id);
    expect(r.code).toBe(1);
    expect(taskState(home, id)).toBe("queued");
    expect(readTask(home, id)).toMatch(/error: \S/);
  });

  it("yol kaçışı: bağımlılık kimliği '../' içeriyorsa launch reddedilir, görev queued kalır", () => {
    cfg({ cloudKb: "readonly" });
    const id = mk();
    const f = taskFile(home, id);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^phase:.*$/m, "$&").replace("\n---\n", "\ndepends_on:\n  - ../../x\n---\n"));
    const r = launchCli(id);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/depends_on|geçersiz|doğrulama/);
    expect(readTask(home, id)).toContain("state: queued");
  });
});

describe("pipeline fazı (readonly): çatı ve bağımlı rapor kb'den okunur, prompt'a girmez", { timeout: 60_000 }, () => {
  it("açılış adımları çatı ve bağımlı dosyaları sayar; çatı/bağımlı içerik ve gate sızmaz; inline kipte çatı+rapor gömülür", () => {
    cfg({ cloudKb: "readonly" });
    const { parent, dep, phase } = pipeline();
    const ro = prepareCloudLaunch(phase, { remoteBranch: () => "exists" });
    expect(ro.kb_access).toBe("readonly");
    expect(ro.integration).toMatchObject({ branch: `vlad/${parent}`, needs_remote_create: false });
    for (const m of [`tasks/${phase}.md`, `tasks/${parent}.md`, `tasks/${dep}.md`, `git merge vlad/${parent}`]) expect(ro.prompt, m).toContain(m);
    for (const m of ["CATI-METNI-ISARETI", DEP_REPORT, BODY, NOTE, GATE]) expect(ro.prompt, m).not.toContain(m);

    // aynı fazı inline'a çevirince eski içerik geri gelir (kipler arası sızıntı/regresyon kontrolü)
    forceQueued(phase);
    const inl = prepareCloudLaunch(phase, { remoteBranch: () => "exists", cloudKb: "inline" });
    for (const m of ["CATI-METNI-ISARETI", DEP_REPORT, BODY, NOTE, GATE]) expect(inl.prompt, m).toContain(m);
  });

  function forceQueued(id: string): void {
    const f = taskFile(home, id);
    writeFileSync(f, readFileSync(f, "utf8").replace("state: running", "state: queued"));
  }
});

describe("sözleşme: launch çıktısı ↔ settings.json ↔ skill'ler", () => {
  it("extra_allowed_tools, .claude/settings.json izin listesiyle birebir; register_repo_root hiçbirinde yok", () => {
    cfg({ cloudKb: "readonly" });
    const j = JSON.parse(launchCli(mk()).out);
    const allow = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")).permissions.allow as string[];
    expect([...allow].sort()).toEqual([...j.extra_allowed_tools].sort());
    expect(j.prompt + JSON.stringify(allow)).not.toContain("register_repo_root");
  });

  it("çalışanın yedek işareti (kb erişimi yok) status ve delegate skill'lerinde tanınan metinle aynı", () => {
    cfg({ cloudKb: "readonly" });
    const { prompt } = JSON.parse(launchCli(mk()).out);
    expect(prompt).toMatch(/\[VLAD:LOG #n\] kb erişimi yok/);
    const status = readFileSync(join(root, ".claude", "skills", "status", "SKILL.md"), "utf8");
    const delegate = readFileSync(join(root, ".claude", "skills", "delegate", "SKILL.md"), "utf8");
    expect(status).toMatch(/\[VLAD:LOG\] kb erişimi yok/);
    expect(delegate).toMatch(/kb erişimi yok/);
    expect(delegate).toMatch(/cloudKb: .inline./);
  });
});

// --- vlad kb check: gerçek bare uzak depo + iki klon, süreç olarak CLI ---
const ident = (n: string) => ({ GIT_AUTHOR_NAME: n, GIT_AUTHOR_EMAIL: `${n}@t`, GIT_COMMITTER_NAME: n, GIT_COMMITTER_EMAIL: `${n}@t` });
const git = (cwd: string, who: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...ident(who) } }).trim();
const commit = (cwd: string, who: string, subject: string, file = `f-${Math.random().toString(36).slice(2)}.md`) => {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), subject + Math.random());
  git(cwd, who, "add", ".");
  git(cwd, who, "commit", "-q", "-m", subject);
  git(cwd, who, "push", "-q", "origin", "HEAD");
};

describe("vlad kb check: CLI süreci, gerçek uzak depo", { timeout: 60_000 }, () => {
  let kb: string;
  let worker: string;
  const check = (...a: string[]) => {
    const r = vlad(home, ["kb", "check", "--json", ...a], { env: { VLAD_KB_DIR: kb } });
    return { ...r, j: r.out.trim() ? JSON.parse(r.out) : null };
  };
  beforeEach(() => {
    const remote = mkdtempSync(join(tmpdir(), "vlad-acc-remote-"));
    kb = mkdtempSync(join(tmpdir(), "vlad-acc-kb-"));
    worker = mkdtempSync(join(tmpdir(), "vlad-acc-worker-"));
    git(remote, "T", "init", "--bare", "-b", "main");
    git(kb, "T", "init", "-b", "main");
    git(kb, "T", "remote", "add", "origin", remote);
    commit(kb, "T", "kb: init");
    git(kb, "T", "push", "-q", "-u", "origin", "main");
    git(worker, "T", "clone", "-q", remote, ".");
  });

  it("yalnız kb: commit'leri → checked:true, boş; --strict çıkış 0", () => {
    commit(worker, "VLAD", "kb: task: T1");
    git(kb, "T", "pull", "-q");
    const r = check("--strict");
    expect(r.code, r.err).toBe(0);
    expect(r.j).toMatchObject({ checked: true, foreign: [], suspicious: [] });
  });

  it("çalışan öneksiz commit atınca listelenir; varsayılan çıkış 0, --strict 1; ack head'e kadar görüldü sayar, sonra temiz", () => {
    check();
    commit(worker, "bulut-calisan", "fix: sessizce kb'ye yazdim");
    const r = check();
    expect(r.code).toBe(0);
    expect(r.j.foreign).toEqual([expect.objectContaining({ author: "bulut-calisan", subject: "fix: sessizce kb'ye yazdim" })]);
    expect(check("--strict").code).toBe(1);
    expect(check("--ack", r.j.head).code).toBe(0);
    const after = check("--strict");
    expect(after.code).toBe(0);
    expect(after.j.foreign).toEqual([]);
  });

  it("--ack sha'sız ya da hex olmayan değerle hata verir ve işaretçiyi ilerletmez", () => {
    commit(worker, "bulut-calisan", "fix: x");
    expect(check("--ack").code).toBe(1);
    expect(check("--ack", "main; rm -rf").code).toBe(1);
    expect(check().j.foreign).toHaveLength(1);
  });

  it("kb: önekli ama CLAUDE.md / .claude/ / iç içe AGENTS.md'ye dokunan commit 'suspicious' çıkar; --strict 1", () => {
    check();
    commit(worker, "bulut-calisan", "kb: sahte onek", "CLAUDE.md");
    commit(worker, "bulut-calisan", "kb: gizli hook", ".claude/settings.json");
    commit(worker, "bulut-calisan", "kb: ic ice", "tasks/sub/AGENTS.md");
    const r = check("--strict");
    expect(r.j.foreign).toEqual([]);
    expect(r.j.suspicious.map((c: { subject: string }) => c.subject).sort()).toEqual(["kb: gizli hook", "kb: ic ice", "kb: sahte onek"]);
    expect(r.code).toBe(1);
  });

  it("kontrol yapılamıyorsa (upstream yok) sessizce temiz görünmez: checked:false, KONTROL YAPILAMADI, --strict 1", () => {
    git(kb, "T", "branch", "--unset-upstream");
    const r = check("--strict");
    expect(r.j.checked).toBe(false);
    expect(r.j.warnings.join("\n")).toContain("KONTROL YAPILAMADI");
    expect(r.code).toBe(1);
    expect(check().code).toBe(0);
  });

  it("kb ayrı depo değilse (VLAD_KB_DIR yok) checked:false", () => {
    const r = vlad(home, ["kb", "check", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).checked).toBe(false);
  });

  // F-vlad-069: merge commit'inin kendisine eklenen (evil merge) CLAUDE.md da suspicious olmalı.
  it("EVIL MERGE: merge commit'ine gizlenen CLAUDE.md suspicious çıkmalı", () => {
    check();
    git(worker, "T", "checkout", "-q", "-b", "side");
    writeFileSync(join(worker, "a.md"), "x\n");
    git(worker, "bulut", "add", ".");
    git(worker, "bulut", "commit", "-q", "-m", "kb: yan dal");
    git(worker, "T", "checkout", "-q", "main");
    commit(worker, "bulut", "kb: ana dal");
    git(worker, "bulut", "merge", "--no-ff", "--no-commit", "side");
    writeFileSync(join(worker, "CLAUDE.md"), "KOTU TALIMAT\n");
    git(worker, "bulut", "add", ".");
    git(worker, "bulut", "commit", "-q", "-m", "kb: merge");
    git(worker, "bulut", "push", "-q", "origin", "main");
    git(kb, "T", "pull", "-q");
    expect(git(kb, "T", "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    const r = check("--strict");
    expect(r.j.suspicious.length).toBeGreaterThan(0);
  });
});
