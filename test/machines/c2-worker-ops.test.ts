import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupOp, closeOp, launchOp, reconcileLaunch, resumeOp } from "../../src/agent/ops/launch.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const ID = "T20261101-61";
const PARENT = "T20261101-60";

let base: string; let home: string; let roots: string; let repo: string; let claudeJson: string;
let saved: Record<string, string | undefined>;
let reqs: LaunchRequest[];
const launcher: Launcher = { launch: async (r) => { reqs.push(r); return { ok: true, method: "fake", detail: "d" }; } };
const failing: Launcher = { launch: async () => ({ ok: false, method: "fake", detail: "pencere açılamadı" }) };
const ctx = (opId = "op-1") => ({ from: "mac", opId });

beforeEach(() => {
  saved = Object.fromEntries(["VLAD_HOME", "VLAD_KB_DIR", "VLAD_MACHINE", "VLAD_CLAUDE_JSON"].map((k) => [k, process.env[k]]));
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-c2w-")));
  roots = join(base, "roots"); repo = join(roots, "alpha");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "f.txt"), "1"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "i");
  home = makeHome();
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, roots: [roots] }] }));
  process.env.VLAD_MACHINE = "windows";
  claudeJson = join(base, "claude.json"); process.env.VLAD_CLAUDE_JSON = claudeJson;
  reqs = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmTemp(base); rmTemp(home);
});

const L = (extra: object = {}) => ({ taskId: ID, project: "alpha", repoName: "alpha", branch: `vlad/${ID}`, base: { kind: "default" }, promptTemplate: "Görev: {{TASK_FILE}}", title: "T", ...extra });
const record = () => JSON.parse(readFileSync(join(home, ".vlad-agent", "launches", `${ID}.json`), "utf8"));

describe("machines:C2 launch op (işçi)", () => {
  it("worktree + dal işçide açılır, güven kaydı yazılır, başlatıcı bir kez çağrılır, kayıt opId'yi taşır", async () => {
    const r = await launchOp(L(), ctx("op-1"), { launcher });
    expect(r.branch).toBe(`vlad/${ID}`);
    expect(r.worktree).toBe(`${repo}-wt\\${ID}`);
    expect(existsSync(r.worktree)).toBe(true);
    expect(git(repo, "branch", "--list", `vlad/${ID}`)).toContain(ID);
    expect(readFileSync(claudeJson, "utf8").split("\\\\").join("/")).toContain(ID);
    expect(reqs).toHaveLength(1);
    expect(record()).toMatchObject({ taskId: ID, worktree: r.worktree, branch: `vlad/${ID}`, opId: "op-1" });
  });

  it("{{TASK_FILE}} işçinin kendi kb yoluyla dolar; VLAD_TASK_ID/VLAD_HOME işçinin kendi değerleri", async () => {
    await launchOp(L({ promptTemplate: "x {{TASK_FILE}} y" }), ctx(), { launcher });
    expect(reqs[0]!.prompt).toBe(`x ${join(home, "kb", "tasks", `${ID}.md`)} y`);
    expect(reqs[0]!.env).toEqual({ VLAD_TASK_ID: ID, VLAD_HOME: home });
  });

  it("pipeline fazı: entegrasyon dalı işçide açılır, faz dalı ondan çıkar, sonuçta integration döner, çatı için de kayıt yazılır", async () => {
    const r = await launchOp(L({ base: { kind: "integration", parent: PARENT } }), ctx(), { launcher });
    expect(r.integration).toEqual({ branch: `vlad/${PARENT}`, worktree: `${repo}-wt\\${PARENT}` });
    expect(existsSync(r.integration!.worktree)).toBe(true);
    expect(readdirSync(join(home, ".vlad-agent", "launches")).sort()).toEqual([`${PARENT}.json`, `${ID}.json`]);
  });

  it("repo yok → not_found 'repo yok: <ad>'; iki kökte aynı ad → conflict 'belirsiz repo adı'; hiçbir şey başlamaz", async () => {
    await expect(launchOp(L({ repoName: "yok" }), ctx(), { launcher })).rejects.toMatchObject({ code: "not_found", message: expect.stringContaining("repo yok: yok") });
    const root2 = join(base, "roots2"); mkdirSync(join(root2, "alpha"), { recursive: true });
    git(join(root2, "alpha"), "init", "-q", "-b", "main");
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 }, roots: [roots, root2] }] }));
    await expect(launchOp(L(), ctx(), { launcher })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("belirsiz repo adı") });
    expect(reqs).toHaveLength(0);
  });

  it("geçersiz argümanlar bad_request: dal ≠ vlad/<id>, yol kaçışı, bilinmeyen alan (worktree/path), external", async () => {
    for (const bad of [{ branch: "main" }, { repoName: ".." }, { repoName: "a/b" }, { project: "../x" }, { taskId: "../../x" }, { worktree: "C:/x" }, { path: "C:/x" }, { external: true }, { base: { kind: "integration", parent: "../p" } }, { base: { kind: "x" } }]) {
      await expect(launchOp(L(bad), ctx(), { launcher }), JSON.stringify(bad)).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(reqs).toHaveLength(0);
  });

  it("başlatıcı başarısızsa failed ve worktree/dal geri alınır, kayıt yazılmaz", async () => {
    await expect(launchOp(L(), ctx(), { launcher: failing })).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("pencere açılamadı") });
    expect(existsSync(`${repo}-wt\\${ID}`)).toBe(false);
    expect(git(repo, "branch", "--list", `vlad/${ID}`)).toBe("");
    expect(existsSync(join(home, ".vlad-agent", "launches", `${ID}.json`))).toBe(false);
  });

  it("aynı görev için kayıt varken farklı opId ile ikinci launch conflict (çift pencere yok)", async () => {
    await launchOp(L(), ctx("op-1"), { launcher });
    await expect(launchOp(L(), ctx("op-2"), { launcher })).rejects.toMatchObject({ code: "conflict" });
    expect(reqs).toHaveLength(1);
  });

  it("açılış uzlaştırması: kayıt varsa sonucu geri verir (applied), yoksa not-applied", async () => {
    const r = await launchOp(L(), ctx("op-9"), { launcher });
    const rec = { opId: "op-9", from: "mac", op: "launch" as const, state: "started" as const, ts: 0, argsHash: "" };
    expect(reconcileLaunch(rec)).toEqual({ verdict: "applied", result: r });
    expect(reconcileLaunch({ ...rec, opId: "op-yok" })).toBe("not-applied");
  });

  it("kayıt başlatıcıdan ÖNCE yazılır (sonuçsuz); çökme sonrası uzlaştırma 'unknown', aynı opId yeniden denemesi çift pencere açmaz", async () => {
    let seen: Record<string, unknown> | null = null;
    const crashing: Launcher = { launch: async () => { seen = record(); throw new Error("süreç öldü"); } };
    // başlatıcı çökmeden önce kaydı gördü; kesin hata olduğundan kayıt silinir
    await expect(launchOp(L(), ctx("op-c"), { launcher: crashing })).rejects.toMatchObject({ code: "failed" });
    expect(seen).toMatchObject({ taskId: ID, opId: "op-c" });
    expect((seen as unknown as { result?: unknown }).result).toBeUndefined();
    // gerçek çökme: kayıt sonuçsuz diskte kalır (başlatıcı hiç dönmedi)
    mkdirSync(join(home, ".vlad-agent", "launches"), { recursive: true });
    writeFileSync(join(home, ".vlad-agent", "launches", `${ID}.json`), JSON.stringify({ taskId: ID, repo, worktree: `${repo}-wt\\${ID}`, branch: `vlad/${ID}`, opId: "op-x" }));
    const rec = { opId: "op-x", from: "mac", op: "launch" as const, state: "started" as const, ts: 0, argsHash: "" };
    expect(reconcileLaunch(rec)).toBe("unknown");
    reqs = [];
    await expect(launchOp(L(), ctx("op-x"), { launcher })).rejects.toMatchObject({ code: "conflict" });
    expect(reqs).toHaveLength(0);
  });

  it("sonuçlu kayıtla aynı opId tekrarı sonucu geri verir, ikinci pencere açmaz", async () => {
    const r1 = await launchOp(L(), ctx("op-r"), { launcher });
    const r2 = await launchOp(L(), ctx("op-r"), { launcher });
    expect(r2).toEqual(r1);
    expect(reqs).toHaveLength(1);
  });
});

describe("machines:C2 close op", () => {
  it("taskId doğrulanır ve işçi tarafı pencereyi kapatır", async () => {
    const asked: string[] = [];
    expect(await closeOp({ taskId: ID }, { close: (id) => { asked.push(id); return [11, 12]; } })).toEqual({ killed: [11, 12] });
    expect(asked).toEqual([ID]);
    expect(await closeOp({ taskId: ID })).toEqual({ killed: [] }); // noop koruması: gerçek süreç öldürülmez
    await expect(closeOp({ taskId: "../x" }, { close: () => [] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(closeOp({ taskId: ID, extra: 1 }, { close: () => [] })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("machines:C2 cleanup op (güvenlik)", () => {
  const C = (extra: object = {}) => ({ taskId: ID, project: "alpha", repoName: "alpha", terminal: true, ...extra });
  const launched = async () => (await launchOp(L(), ctx(), { launcher })).worktree;

  it("worktree işçide silinir, güven kaydı kalkar, başlatma kaydı silinir", async () => {
    const wt = await launched();
    expect(await cleanupOp(C(), { close: () => [] })).toEqual({ removed: true });
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(ID);
    expect(readFileSync(claudeJson, "utf8")).not.toContain(ID);
    expect(existsSync(join(home, ".vlad-agent", "launches", `${ID}.json`))).toBe(false);
  });

  it("kayıt yok, terminal:false/eksik, bilinmeyen alan (path/worktree), bozuk repoName/project/taskId → forbidden/bad_request; hiçbir şey silinmez", async () => {
    const wt = await launched();
    const outside = join(base, "kritik"); mkdirSync(outside); writeFileSync(join(outside, "a.txt"), "x");
    const cases: [object, string][] = [
      [C({ taskId: "T20990101-77" }), "forbidden"], [C({ terminal: false }), "forbidden"], [{ project: "alpha", repoName: "alpha", taskId: ID }, "forbidden"],
      [C({ path: outside }), "bad_request"], [C({ worktree: outside }), "bad_request"], [C({ repoName: ".." , project: "../x" }), "bad_request"], [C({ taskId: "../../kritik" }), "bad_request"],
    ];
    for (const [a, code] of cases) await expect(cleanupOp(a, { close: () => [] }), JSON.stringify(a)).rejects.toMatchObject({ code });
    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("x");
  });

  it("oynanmış kayıt (yol kök dışına işaret ediyor) → forbidden, hedef silinmez", async () => {
    const wt = await launched();
    const outside = join(base, "kritik2"); mkdirSync(outside); writeFileSync(join(outside, "a.txt"), "x");
    const f = join(home, ".vlad-agent", "launches", `${ID}.json`);
    const j = JSON.parse(readFileSync(f, "utf8")); j.worktree = outside; writeFileSync(f, JSON.stringify(j));
    await expect(cleanupOp(C(), { close: () => [] })).rejects.toMatchObject({ code: "forbidden" });
    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("x");
  });

  it("fail-closed: güven kaydı kaldırılamazsa worktree silinmez ve failed döner", async () => {
    const wt = await launched();
    rmSync(claudeJson, { force: true }); mkdirSync(claudeJson); // dosya yerine dizin: yazılamaz
    await expect(cleanupOp(C(), { close: () => [] })).rejects.toMatchObject({ code: "failed" });
    expect(existsSync(wt)).toBe(true);
  });

  it("worktree zaten yoksa removed:false (idempotent); kayıt temizlenir", async () => {
    const wt = await launched();
    await cleanupOp(C(), { close: () => [] });
    writeFileSync(join(home, ".vlad-agent", "launches", `${ID}.json`), JSON.stringify({ taskId: ID, repo, worktree: wt, branch: `vlad/${ID}`, opId: "o" }));
    expect(await cleanupOp(C(), { close: () => [] })).toEqual({ removed: false });
    expect(existsSync(join(home, ".vlad-agent", "launches", `${ID}.json`))).toBe(false);
  });
});

describe("machines:C2 resume op (işçi)", () => {
  const R = (extra: object = {}) => ({ taskId: ID, project: "alpha", repoName: "alpha", promptTemplate: "Dizin {{WORKTREE}}\n{{DIRTY_LINE}}\nDosya {{TASK_FILE}}", title: "T", ...extra });

  it("kendi worktree'sini ve dalını denetler, kirli yolları listeler, devam bayraklı yeniden başlatır", async () => {
    const wt = (await launchOp(L(), ctx(), { launcher })).worktree;
    writeFileSync(join(wt, "yeni.txt"), "x");
    reqs = [];
    const r = await resumeOp(R({ sessionId: "sess-1" }), { launcher });
    expect(r).toMatchObject({ worktree: wt, method: "fake", dirty: ["yeni.txt"] });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ cwd: wt, resume: { sessionId: "sess-1" } });
    expect(reqs[0]!.prompt).toContain(`Dizin ${wt}`);
    expect(reqs[0]!.prompt).toContain("yeni.txt");
    expect(reqs[0]!.prompt).not.toContain("{{");
  });

  it("yeniden başlatmadan önce eski pencereyi kapatır (yanında ikinci pencere açılmaz)", async () => {
    await launchOp(L(), ctx(), { launcher }); reqs = [];
    const asked: string[] = [];
    await resumeOp(R(), { launcher, close: (id) => { asked.push(id); return []; } });
    expect(asked).toEqual([ID]);
  });

  it("sessionId '-' ile başlayamaz (claude'a seçenek gibi görünmesin)", async () => {
    await launchOp(L(), ctx(), { launcher });
    await expect(resumeOp(R({ sessionId: "-x" }), { launcher })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("sessionId yoksa --continue (resume.sessionId undefined)", async () => {
    await launchOp(L(), ctx(), { launcher }); reqs = [];
    await resumeOp(R(), { launcher });
    expect(reqs[0]!.resume).toEqual({ sessionId: undefined });
  });

  it("worktree yok → not_found; yanlış dal → failed; kayıt yok → forbidden; hiçbiri pencere açmaz", async () => {
    await expect(resumeOp(R(), { launcher })).rejects.toMatchObject({ code: "forbidden" });
    const wt = (await launchOp(L(), ctx(), { launcher })).worktree; reqs = [];
    git(wt, "checkout", "-q", "-b", "baska");
    await expect(resumeOp(R(), { launcher })).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("yanlış branch") });
    rmSync(wt, { recursive: true, force: true });
    await expect(resumeOp(R(), { launcher })).rejects.toMatchObject({ code: "not_found" });
    expect(reqs).toHaveLength(0);
  });
});
