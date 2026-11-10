// vlad setup parça/orkestrasyon testleri (T20261110-05). Her test geçici HOME/claudeDir/vladHome kullanır; gerçek ~/.claude ve kb'ye dokunulmaz.
// Gerçek gh/launchctl/schtasks/git-clone yok: komut yürütücü sahte (setRunner).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmTemp } from "../helpers.js";
import { setRunner, type Runner } from "../../src/setup/io.js";
import { buildContext, runAddWorker, runCheck, runJoin, runSetup, runUninstall, runUpgrade } from "../../src/setup/run.js";
import { WORKER_DENY, WORKER_PERMISSIONS } from "../../src/setup/parts-files.js";
import type { SetupAnswers } from "../../src/setup/index.js";

const repo = resolve(import.meta.dirname, "..", "..");
let root: string, vladHome: string, home: string, claudeDir: string, calls: string[][];
const w = (p: string, s: string) => { mkdirSync(resolve(p, ".."), { recursive: true }); writeFileSync(p, s); };
const jr = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const settings = () => join(claudeDir, "settings.json");
const ctx = (answers: SetupAnswers = {}, o: { dryRun?: boolean; yes?: boolean; platform?: "darwin" | "win32" | "linux" } = {}) =>
  buildContext({ vladHome, env: { VLAD_CLAUDE_DIR: claudeDir }, home, answers, platform: o.platform ?? "darwin", dryRun: o.dryRun, yes: o.yes });
const fake: Runner = (cmd, args, o) => {
  calls.push([cmd, ...args]);
  if (cmd === "claude") return { ok: true, code: 0, stdout: "usage: claude --autocompact <n>", stderr: "" };
  if (cmd === "git" && args[0] === "--version") return { ok: true, code: 0, stdout: "git version 2.50.0", stderr: "" };
  if (cmd === "git" && args[0] === "init") { mkdirSync(join(o?.cwd ?? ".", ".git"), { recursive: true }); return { ok: true, code: 0, stdout: "", stderr: "" }; }
  if (cmd === "gh" && args[0] === "repo" && args[1] === "clone") { mkdirSync(join(args[3]!, ".git"), { recursive: true }); return { ok: true, code: 0, stdout: "", stderr: "" }; }
  if (cmd === "git" && args[0] === "clone") { mkdirSync(join(args[2]!, ".git"), { recursive: true }); return { ok: true, code: 0, stdout: "", stderr: "" }; }
  if (cmd === "gh" && args[0] === "repo" && args[1] === "view" && args[2]!.startsWith("denied/")) return { ok: false, code: 1, stdout: "", stderr: "not found" };
  if (cmd === "git" && args[0] === "ls-remote") return args[1]!.includes("denied/") ? { ok: false, code: 128, stdout: "", stderr: "no access" } : { ok: true, code: 0, stdout: "", stderr: "" };
  return { ok: true, code: 0, stdout: "x 1.0", stderr: "" };
};
const SINGLE: SetupAnswers = { role: "brain", machines: "single", kb: { mode: "local", dir: "" }, roots: ["~/dev"] };
const ans = (extra: SetupAnswers = {}): SetupAnswers => ({ ...SINGLE, kb: { mode: "local", dir: join(root, "kb") }, ...extra });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-setup-")));
  vladHome = join(root, "vlad"); home = join(root, "home"); claudeDir = join(home, ".claude");
  mkdirSync(join(home, "dev"), { recursive: true });
  cpSync(join(repo, "schemas"), join(vladHome, "schemas"), { recursive: true });
  cpSync(join(repo, "global"), join(vladHome, "global"), { recursive: true });
  w(join(vladHome, ".claude", "skills", "delegate", "SKILL.md"), "x");
  for (const n of ["design-taste-frontend", "impeccable", "ui-ux-pro-max"]) w(join(vladHome, ".claude", "skills", n, "SKILL.md"), n);
  w(join(vladHome, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/dist/cli.js" status --summary --hook' }] }] } }));
  w(join(vladHome, "dist", "cli.js"), ""); w(join(vladHome, "dist", "hooks", "session-report.js"), "");
  // maintainer'ın tracked config'i (kişisel: makineler, projeler) — arkadaş kurulumunda taşınmamalı
  w(join(vladHome, "vlad.config.json"), JSON.stringify({ roots: ["/m"], brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { host: "192.168.1.35", port: 7437 } }, { name: "windows", os: "win32", agent: { host: "192.168.1.34", port: 7437 } }], workerAutoCompact: "300k", experiments: { ponytail: "ab" }, projects: { watchparty: { autonomy: "commit" } }, kbDir: "../vlad-kb" }));
  calls = []; setRunner(fake);
  vi.stubEnv("VLAD_HOME", vladHome); vi.stubEnv("VLAD_KB_DIR", ""); vi.stubEnv("VLAD_MACHINE", ""); vi.stubEnv("VLAD_LOCAL_FILE", join(root, "vlad.local.json"));
});
afterEach(() => { setRunner(null); vi.unstubAllEnvs(); rmTemp(root); });

const snapshot = (dir: string): Record<string, string> => {
  const o: Record<string, string> = {};
  const walk = (d: string) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== ".git") walk(p); } else o[p] = readFileSync(p, "utf8") + statSync(p).mtimeMs; } };
  walk(dir); return o;
};

describe("senaryo 1: tek makine, yerel kb", () => {
  it("settings + skill + overlay + kb yazılır; arkadaşa maintainer'ın makineleri/projeleri taşınmaz; sonra --check yeşil", async () => {
    await runSetup(ctx(ans({ fresh: true }), { yes: true }));
    expect(jr(settings()).hooks.SessionEnd[0].hooks[0].command).toContain("session-report.js");
    for (const n of ["vlad-worker", "ci-triage"]) expect(existsSync(join(claudeDir, "skills", n, "SKILL.md"))).toBe(true);
    const local = jr(join(vladHome, "vlad.config.local.json"));
    expect(local).toMatchObject({ machines: null, brain: null, workerAutoCompact: null, experiments: null, projects: null, kbDir: join(root, "kb"), roots: [join(home, "dev")] });
    expect(existsSync(join(root, "kb", ".git"))).toBe(true);
    const gi = readFileSync(join(root, "kb", ".gitignore"), "utf8");
    for (const l of ["inbox/", "logs/", "vlad-session.txt", ".vlad.lock*"]) expect(gi).toContain(l);
    const r = await runCheck(ctx(ans()));
    expect(r.parts.filter((p) => p.status !== "ok" && p.status !== "n/a" && p.severity === "error").map((p) => `${p.part}: ${p.evidence}`)).toEqual([]);
    expect(r.exit).toBe(0);
  });
  it("izin kalıpları onaysız yazılmaz (--yes onayı atlamaz); push/gh repo create çağrılmaz", async () => {
    await runSetup(ctx(ans({ perms: true, claudedirs: true }), { yes: true }));
    expect(jr(settings()).permissions).toBeUndefined();
    expect(calls.filter((c) => (c[0] === "gh" && c[1] !== "auth") || (c[0] === "git" && c[1] === "push"))).toEqual([]);
  });
});

describe("senaryo 3: idempotens", () => {
  it("ikinci koşu hiçbir dosyayı değiştirmez, yedek oluşturmaz, hepsi 'zaten güncel'", async () => {
    const a = ans({ perms: true, confirm: ["permissions-write"] });
    await runSetup(ctx(a, { yes: true }));
    const before = { ...snapshot(claudeDir), ...snapshot(vladHome), ...snapshot(join(root, "kb")) };
    const baks = readdirSync(claudeDir).filter((f) => f.includes(".bak-"));
    const second = await runSetup(ctx(a, { yes: true }));
    expect({ ...snapshot(claudeDir), ...snapshot(vladHome), ...snapshot(join(root, "kb")) }).toEqual(before);
    expect(second.filter((r) => r.changed).map((r) => r.part)).toEqual([]);
    expect(readdirSync(claudeDir).filter((f) => f.includes(".bak-"))).toEqual(baks);
  });
});

describe("senaryo 4/5: var olan kullanıcı ayarı ve bozuk settings.json", () => {
  it("model/autoMode/başka hook/izinler korunur, yalnız eksik VLAD girişi eklenir, tek yedek", async () => {
    const mine = { model: "opus", autoMode: { environment: ["x"] }, permissions: { allow: ["Bash(ls:*)"] }, hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "mine" }] }] } };
    w(settings(), JSON.stringify(mine));
    await runSetup(ctx(ans({ perms: true, confirm: ["permissions-write"] })));
    const s = jr(settings());
    expect(s.model).toBe("opus"); expect(s.autoMode).toEqual(mine.autoMode);
    expect(s.permissions.allow).toEqual(["Bash(ls:*)", ...WORKER_PERMISSIONS]);
    expect(s.hooks.SessionEnd).toHaveLength(2);
    expect(s.hooks.SessionEnd[0]).toEqual(mine.hooks.SessionEnd[0]);
    expect(readdirSync(claudeDir).filter((f) => f.startsWith("settings.json.bak-")).length).toBeGreaterThanOrEqual(1);
  });
  it("geniş izin kalıbı (Bash(*), git push:*) asla yazılmaz", () => {
    expect(WORKER_PERMISSIONS.filter((p) => /^Bash\(\*\)|push:\*|\(\*\)/.test(p))).toEqual([]);
    expect(WORKER_PERMISSIONS.every((p) => /vlad\/\*|gh (run|workflow)/.test(p))).toBe(true);
  });
  it("farklı timeout'lu mevcut VLAD hook'u çakışan raporlanır ve değiştirilmez", async () => {
    const cmd = `node "${join(vladHome, "dist", "hooks", "session-report.js")}"`;
    w(settings(), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: cmd, timeout: 2 }] }] } }));
    const before = readFileSync(settings(), "utf8");
    const r = await runSetup(ctx(ans()), { only: ["hooks"] });
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(r[0]!.actions[0]!.what).toContain("çakışan");
    expect((await runCheck(ctx(), { only: ["hooks"] })).parts[0]!.status).toBe("çakışan");
  });
  it("bozuk settings.json: kurulum durur, dosyaya yazılmaz, --check çakışan", async () => {
    w(settings(), "{bozuk");
    await expect(runSetup(ctx(ans(), { yes: true }), { only: ["hooks"] })).rejects.toThrow(/geçerli JSON değil/);
    expect(readFileSync(settings(), "utf8")).toBe("{bozuk");
    expect((await runCheck(ctx(), { only: ["hooks"] })).parts[0]!.status).toBe("çakışan");
  });
});

describe("senaryo 6/7: yükseltme drift'i ve eksik build", () => {
  it("eski global skill --check'te 'eski' (çıkış 1); --upgrade eşitler, yerel dosyayı yedekler", async () => {
    await runSetup(ctx(ans(), { yes: true }));
    const f = join(claudeDir, "skills", "vlad-worker", "SKILL.md");
    writeFileSync(f, "eski yerel içerik");
    const r = await runCheck(ctx(), { only: ["global-skills"] });
    expect(r.parts[0]!.status).toBe("eski"); expect(r.exit).toBe(1);
    const up = await runUpgrade(ctx());
    expect(readFileSync(f, "utf8")).toBe(readFileSync(join(vladHome, "global", "skills", "vlad-worker", "SKILL.md"), "utf8"));
    expect(up.find((x) => x.part === "global-skills")!.backups.length).toBe(1);
    expect(readFileSync(up.find((x) => x.part === "global-skills")!.backups[0]! + "/SKILL.md", "utf8")).toBe("eski yerel içerik");
  });
  it("dist yok → cli: eksik + 'npm run build' önerisi", async () => {
    rmTemp(join(vladHome, "dist"));
    const p = (await runCheck(ctx(), { only: ["cli"] })).parts[0]!;
    expect(p.status).toBe("eksik"); expect(p.fix).toContain("npm run build");
  });
});

describe("inceleme düzeltmeleri", () => {
  it("aynı saniyede ikinci settings yedeği öncekini ezmez", async () => {
    w(settings(), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    const a = ans({ perms: true, confirm: ["permissions-write"] });
    const r1 = await runSetup(ctx(a, { yes: true }), { only: ["permissions"] });
    w(settings(), JSON.stringify({ permissions: { allow: ["Bash(pwd)"] } }));
    const r2 = await runSetup(ctx(a, { yes: true }), { only: ["permissions"] });
    const b = [...r1[0]!.backups, ...r2[0]!.backups];
    expect(new Set(b).size).toBe(b.length);
    expect(b.length).toBe(2);
  });
  it("permissions.allow dizi değilse yazmadan hata verir", async () => {
    w(settings(), JSON.stringify({ permissions: { allow: "x" } }));
    await expect(runSetup(ctx(ans({ perms: true, confirm: ["permissions-write"] }), { yes: true }), { only: ["permissions"] })).rejects.toThrow(/dizi/);
    expect(jr(settings()).permissions.allow).toBe("x");
  });
  it("--join: machine.name yoksa baştan hata, hiçbir şey yazılmaz (P1-1)", async () => {
    await expect(runJoin(ctx(ans(), { yes: true }), { brain: "boss", brainHost: "192.168.1.5", brainOs: "darwin" })).rejects.toThrow(/machine\.name/);
    expect(existsSync(join(vladHome, "vlad.config.local.json"))).toBe(false);
  });
  it("agent.apply makine adı yoksa self'e dokunmaz", async () => {
    const f = join(root, "vlad.local.json"); writeFileSync(f, JSON.stringify({ self: "keep", keys: {} }));
    await expect(runSetup(ctx({ role: "brain", machines: "multi" } as SetupAnswers, { yes: true }), { only: ["agent"] })).rejects.toThrow();
    expect(jr(f).self).toBe("keep");
  });
  it("--join: ad/hostname reddedilir, port aralığı doğrulanır", async () => {
    await expect(runJoin(ctx(ans({ machine: { name: "friend-pc" } }), { yes: true }), { brain: "boss", brainHost: "boss.example.com", brainPort: 7437, brainOs: "darwin" } as never)).rejects.toThrow(/IPv4/);
    await expect(runJoin(ctx(ans({ machine: { name: "friend-pc" } }), { yes: true }), { brain: "boss", brainHost: "192.168.1.5", brainPort: 80, brainOs: "darwin" } as never)).rejects.toThrow(/1024/);
  });
  it("--uninstall config silmeden önce yedek bırakır", async () => {
    await runSetup(ctx(ans(), { yes: true }), { only: ["config"] });
    const u = await runUninstall(ctx(ans(), { yes: true }), "config");
    expect(u.backups.length).toBe(1);
    expect(existsSync(u.backups[0]!)).toBe(true);
  });
});

describe("senaryo 11: kb modları", () => {
  it("github-new onay yoksa repo oluşturulmaz; onayla gh repo create --private, push yok", async () => {
    const a = ans({ kb: { mode: "github-new", dir: join(root, "kb2"), remote: "me/vlad-kb" } });
    const r = await runSetup(ctx(a, { yes: true }), { only: ["kb"] });
    expect(r[0]!.skipped).toBeTruthy(); expect(calls.some((c) => c[0] === "gh")).toBe(false); expect(existsSync(join(root, "kb2"))).toBe(false);
    await runSetup(ctx({ ...a, confirm: ["kb-repo-create"] }, { yes: true }), { only: ["kb"] });
    expect(calls.find((c) => c[0] === "gh" && c[2] === "create")).toEqual(["gh", "repo", "create", "me/vlad-kb", "--private"]);
    expect(calls.some((c) => c[0] === "git" && c[1] === "push")).toBe(false);
    expect(existsSync(join(root, "kb2", ".git"))).toBe(true);
  });
  it("existing: erişim yoksa hata ve hiçbir şey yazılmaz; erişim varsa klonlanır", async () => {
    await expect(runSetup(ctx(ans({ kb: { mode: "existing", dir: join(root, "kb3"), remote: "denied/x" } })), { only: ["kb"] })).rejects.toThrow(/erişilemiyor/);
    expect(existsSync(join(root, "kb3"))).toBe(false);
    await runSetup(ctx(ans({ kb: { mode: "existing", dir: join(root, "kb3"), remote: "me/vlad-kb" } })), { only: ["kb"] });
    expect(calls.some((c) => c[0] === "gh" && c[1] === "repo" && c[2] === "clone")).toBe(true);
  });
  it("path: git deposu olmayan dizin reddedilir", async () => {
    mkdirSync(join(root, "plain"));
    await expect(runSetup(ctx(ans({ kb: { mode: "path", dir: join(root, "plain") } })), { only: ["kb"] })).rejects.toThrow(/git deposu değil/);
  });
});

describe("senaryo 12/dry-run: mevcut kurulum bozulmaz", () => {
  it("--dry-run ve --check hiçbir dosya değiştirmez; tracked config bayt aynı", async () => {
    const before = { ...snapshot(claudeDir), ...snapshot(vladHome), ...snapshot(root + "/kb") };
    await runSetup(ctx(ans(), { dryRun: true, yes: true }));
    await runCheck(ctx());
    expect({ ...snapshot(claudeDir), ...snapshot(vladHome), ...snapshot(root + "/kb") }).toEqual(before);
  });
  it("kullanıcının kendi yerel katmanındaki farklı değer --yes olmadan ezilmez (çakışan)", async () => {
    w(join(vladHome, "vlad.config.local.json"), JSON.stringify({ roots: ["/benim"] }));
    const r = await runSetup(ctx(ans()), { only: ["config"] });
    expect(jr(join(vladHome, "vlad.config.local.json")).roots).toEqual(["/benim"]);
    expect(r[0]!.actions.some((a) => a.what.startsWith("roots"))).toBe(true);
  });
});

describe("senaryo 8: çok makine ve anahtar", () => {
  const MULTI = (name: string, role: "brain" | "worker", host: string): SetupAnswers => ({ role, machines: "multi", machine: { name, agent: { host } }, kb: { mode: "local", dir: join(root, "kb") }, roots: ["~/dev"], ...(role === "brain" ? { keys: "generate" as const } : {}) });
  it("beyin: işçi eklenir, anahtar yalnız onayla üretilir, çıktıda 64-hex yok, vlad.local.json 0600", async () => {
    const a = { ...MULTI("mbp", "brain", "192.168.1.35"), confirm: ["keygen" as const] };
    const res = await runSetup(ctx(a, { yes: true }));
    await runAddWorker(ctx(a, { yes: true }), "pc2", { os: "win32", host: "192.168.1.34" });
    const local = jr(join(vladHome, "vlad.config.local.json"));
    expect(local.brain).toBe("mbp"); expect(local.machines.map((m: any) => m.name)).toEqual(["mbp", "pc2"]);
    await runSetup(ctx(a, { yes: true }), { only: ["agent"] });
    const lf = jr(join(root, "vlad.local.json"));
    expect(lf.self).toBe("mbp"); expect(Object.keys(lf.keys).sort()).toEqual(["mbp", "pc2"]);
    expect(statSync(join(root, "vlad.local.json")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(res)).not.toMatch(/[0-9a-f]{64}/);
  });
  it("onaysız keygen anahtar üretmez", async () => {
    await runSetup(ctx(MULTI("mac", "brain", "192.168.1.35"), { yes: true }));
    expect(existsSync(join(root, "vlad.local.json")) ? jr(join(root, "vlad.local.json")).keys : {}).toEqual({});
  });
  it("işçi: --join beyin girdisini yazar, anahtar stdin değeriyle keys.<beyin>'e gider; çıktıda sızmaz", async () => {
    const key = "ab".repeat(32);
    const res = await runJoin(ctx(MULTI("friend-pc", "worker", "192.168.1.34"), { yes: true }), { brain: "boss", brainHost: "192.168.1.35", brainOs: "darwin", brainKey: key });
    const lf = jr(join(root, "vlad.local.json"));
    expect(lf.self).toBe("friend-pc"); expect(lf.keys.boss).toBe(key);
    expect(JSON.stringify(res)).not.toContain(key);
    expect(jr(join(vladHome, "vlad.config.local.json")).brain).toBe("boss");
  });
  it("genel adres reddedilir (agent.host / --brain-host / --host)", async () => {
    await expect(runJoin(ctx(MULTI("friend-pc", "worker", "192.168.1.34")), { brain: "boss", brainHost: "8.8.8.8", brainOs: "darwin" })).rejects.toThrow(/genel adres/);
    await expect(runAddWorker(ctx(), "x", { os: "win32", host: "8.8.8.8" })).rejects.toThrow(/genel adres/);
  });
  it("tek makine: agent parçası n/a", async () => {
    await runSetup(ctx(ans({ fresh: true }), { yes: true }));
    expect((await runCheck(ctx(), { only: ["agent"] })).parts[0]!.status).toBe("n/a");
  });
});

describe("senaryo 9: Linux", () => {
  it("--check 'deneysel' satırı basar; mac-main n/a", async () => {
    const r = await runCheck(ctx({}, { platform: "linux" }));
    expect(r.experimental?.[0]).toMatch(/deneysel/);
    expect(r.parts.find((p) => p.part === "mac-main")!.status).toBe("n/a");
  });
});

describe("geri alma ve parça seçimi", () => {
  it("--uninstall hooks yalnız VLAD girişini kaldırır; kullanıcı hook'u kalır", async () => {
    w(settings(), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "mine" }] }] } }));
    await runSetup(ctx(ans()), { only: ["hooks"] });
    await runUninstall(ctx(), "hooks");
    expect(jr(settings()).hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: "mine" }] }]);
  });
  it("--uninstall desteklemeyen parça hata verir", async () => {
    await expect(runUninstall(ctx(), "kb")).rejects.toThrow(/desteklenmiyor/);
  });
});

describe("güvenlik kararları (değişiklik turu)", () => {
  const perms = () => ans({ perms: true, confirm: ["permissions-write"] });
  it("izinler: deny kalıpları eklenir, var olan deny korunur", async () => {
    w(settings(), JSON.stringify({ permissions: { deny: ["Bash(rm -rf *)"] } }));
    await runSetup(ctx(perms(), { yes: true }), { only: ["permissions"] });
    const d = jr(settings()).permissions.deny;
    expect(d).toEqual(["Bash(rm -rf *)", ...WORKER_DENY]);
  });
  // F-vlad-293: `*` boş eşleşemez (ayraç boşluğu kalıpta durur): sonda ve hemen `push`'tan sonra gelen -f/-d/--force/--delete ayrı kalıp ister.
  it("deny kalıpları sonda ve push'tan hemen sonra -f/-d/--force/--delete biçimlerini kapsar (glob anlamıyla)", () => {
    const glob = (pat: string, cmd: string) => new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(cmd);
    const blocked = (cmd: string) => WORKER_DENY.map((d) => d.slice(5, -1)).some((p) => glob(p, cmd));
    for (const cmd of ["git push origin vlad/x -f", "git push origin vlad/x -d", "git push origin -d vlad/x", "git push -f origin vlad/x", "git push -d origin vlad/x", "git push --force origin x", "git push --delete origin x", "git push origin x --force", "git push origin x -f"]) expect(blocked(cmd), cmd).toBe(true);
    for (const cmd of ["git push origin vlad/x", "git push -u origin vlad/x"]) expect(blocked(cmd), cmd).toBe(false);
  });
  it("onay metni push kalıbının tüm Claude oturumlarına geçerli olduğunu söyler", async () => {
    const r = await runSetup(ctx(ans({ perms: true }), { yes: true }), { only: ["permissions"] });
    expect(r[0]!.actions[0]!.what).toMatch(/TÜM Claude oturumlarına/);
  });
  it("plugins: bilinmeyen pazar yeri plugins-write olmadan etkinleşmez", async () => {
    await runSetup(ctx(ans({ plugins: ["x@bilinmeyen"] }), { yes: true }), { only: ["plugins"] });
    expect(existsSync(settings()) ? (jr(settings()).enabledPlugins ?? {})["x@bilinmeyen"] : undefined).toBeUndefined();
    await runSetup(ctx(ans({ plugins: ["x@bilinmeyen"], confirm: ["plugins-write"] }), { yes: true }), { only: ["plugins"] });
    expect(jr(settings()).enabledPlugins["x@bilinmeyen"]).toBe(true);
  });
  it("yerel config yedekleri ve dosyası .gitignore'da (/vlad.config.local.json*)", () => {
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain("/vlad.config.local.json*");
  });
  it("yeni yazılan yerel config 0600", async () => {
    await runSetup(ctx(ans(), { yes: true }), { only: ["config"] });
    if (process.platform !== "win32") expect(statSync(join(vladHome, "vlad.config.local.json")).mode & 0o777).toBe(0o600);
  });
  it("tracked ile birebir aynı machines/brain yerel katmana yazılmaz (F-P2-5)", async () => {
    await runSetup(ctx(MULTI_MAC(), { yes: true }), { only: ["config"] });
    const l = jr(join(vladHome, "vlad.config.local.json"));
    expect(l.machines).toBeUndefined(); expect(l.brain).toBeUndefined();
  });
  it("fresh olmadan tracked kişisel değerler nötrlenmez; fresh:true ile nötrlenir (F-P2-3)", async () => {
    await runSetup(ctx(ans(), { yes: true }), { only: ["config"] });
    expect(jr(join(vladHome, "vlad.config.local.json")).projects).toBeUndefined();
  });
  // F-vlad-294: arkadaş, sahibin tracked machines'indeki bir adla (windows) kurulursa sahibin kişisel alanları (roots/kbDir/bind/host) yerel katmana taşınmaz.
  it("tracked adla kurulan arkadaş: sahip girdisinin roots/kbDir/bind alanları kopyalanmaz (F-vlad-294)", async () => {
    const t = jr(join(vladHome, "vlad.config.json"));
    t.machines[1] = { ...t.machines[1], bind: "192.168.1.34", roots: ["C:\\dev"], kbDir: "C:\\dev\\vlad-kb" };
    w(join(vladHome, "vlad.config.json"), JSON.stringify(t));
    await runSetup(ctx(ans({ fresh: true, role: "worker", machines: "multi", machine: { name: "windows", agent: { host: "192.168.1.77", port: 7437 } } }), { yes: true }), { only: ["config"] });
    const mine = jr(join(vladHome, "vlad.config.local.json")).machines.find((m: { name: string }) => m.name === "windows");
    expect(mine).toEqual({ name: "windows", os: "darwin", agent: { host: "192.168.1.77", port: 7437 } });
  });
  it("machines cevapsız + tracked çok makineli + self tanımsız: açık hata (P1-2)", async () => {
    const a = ans(); delete a.machines;
    await expect(runSetup(ctx(a, { yes: true }), { only: ["config"] })).rejects.toThrow(/machines/);
  });
  it("answers host ad/hostname reddedilir (validateAnswers)", async () => {
    const { validateAnswers } = await import("../../src/setup/index.js");
    expect(validateAnswers({ ...SINGLE, machines: "multi", machine: { name: "x", agent: { host: "pc.local" } } }, { platform: "darwin" }).ok).toBe(false);
    expect(validateAnswers({ ...SINGLE, kb: { mode: "existing", remote: "../x/y" } }, { platform: "darwin" }).ok).toBe(false);
  });
});
const MULTI_MAC = (): SetupAnswers => ({ role: "brain", machines: "multi", machine: { name: "mac", agent: { host: "192.168.1.35", port: 7437 } }, kb: { mode: "local", dir: join(root, "kb") }, roots: ["~/dev"] });

describe("sihirbaz (P1-2, G-bilgi-9)", () => {
  it("Enter: choice varsayılanı uygulanır; sözde varsayılan parantezle gösterilmez; onay soruları açıkça sorulur", async () => {
    const { interviewAnswers } = await import("../../src/setup/interactive.js");
    const prompts: [string, string | undefined][] = [];
    const out = await interviewAnswers(async (p, d) => { prompts.push([p, d]); return /^Onay: permissions-write/.test(p) ? "e" : p.startsWith("Çalışan push/CI izinleri") ? "e" : ""; }, "darwin");
    expect(out.role).toBe("brain"); expect(out.machines).toBe("single"); expect(out.kb?.mode).toBe("local");
    expect(prompts.find(([p]) => p.startsWith("kbDir"))![1]).toBeUndefined();
    expect(out.confirm).toEqual(["permissions-write"]);
  });
});

// ---- T20261110-21: son kapı P1/P2 ----
describe("sihirbaz varsayılanları mevcut config'ten tohumlanır (P1)", () => {
  const enter = async () => "";
  it("boş Enter sihirbazı sahibin çok makineli tracked config'inde machines/brain'i null'lamaz", async () => {
    vi.stubEnv("VLAD_MACHINE", "mac");
    const { interviewAnswers, wizardSeed } = await import("../../src/setup/interactive.js");
    const raw = await interviewAnswers(enter, "darwin", wizardSeed(vladHome));
    expect(raw.machines).toBe("multi"); expect(raw.role).toBe("brain"); expect(raw.machine?.name).toBe("mac");
    await runSetup(ctx({ ...raw, kb: { mode: "local", dir: join(root, "kb") } }, { yes: true }), { only: ["config"] });
    const lp = join(vladHome, "vlad.config.local.json");
    const l = existsSync(lp) ? jr(lp) : {};
    expect(l.machines).not.toBeNull(); expect(l.brain).not.toBeNull(); expect(l.consoles).not.toBeNull();
  });
  it("işçi makinede (self≠brain) Enter role=worker verir", async () => {
    vi.stubEnv("VLAD_MACHINE", "windows");
    const { interviewAnswers, wizardSeed } = await import("../../src/setup/interactive.js");
    const raw = await interviewAnswers(enter, "win32", wizardSeed(vladHome));
    expect(raw.role).toBe("worker"); expect(raw.machines).toBe("multi");
  });
  it("tracked çok makineli + machines:single + fresh yok: machines/brain null'lanmaz, uyarı basılır", async () => {
    const rs = await runSetup(ctx(ans(), { yes: true }), { only: ["config"] });
    const lp = join(vladHome, "vlad.config.local.json");
    const l = existsSync(lp) ? jr(lp) : {};
    expect("machines" in l).toBe(false); expect("brain" in l).toBe(false);
    expect(rs[0]!.actions.some((a) => a.kind === "print" && /machines/.test(a.what))).toBe(true);
  });
  it("fresh:true ile tek makine arkadaş kurulumu hâlâ çalışır (machines/brain null) ve yüksek sesli uyarı verir", async () => {
    const rs = await runSetup(ctx(ans({ fresh: true }), { yes: true }), { only: ["config"] });
    const l = jr(join(vladHome, "vlad.config.local.json"));
    expect(l.machines).toBeNull(); expect(l.brain).toBeNull();
    expect(rs[0]!.actions.some((a) => a.kind === "print" && /machines/.test(a.what))).toBe(true);
  });
});

describe("overlay: host değişiminde sahibin alanları (P2-2)", () => {
  it("fresh olmadan DHCP ile host değişti: roots/kbDir/bind korunur, host güncellenir, adres değişikliği bildirilir", async () => {
    const t = jr(join(vladHome, "vlad.config.json"));
    t.machines[1] = { ...t.machines[1], agent: { ...t.machines[1].agent, bind: "192.168.1.34" }, roots: ["C:\\dev"], kbDir: "C:\\dev\\vlad-kb" };
    w(join(vladHome, "vlad.config.json"), JSON.stringify(t));
    const rs = await runSetup(ctx(ans({ role: "worker", machines: "multi", machine: { name: "windows", agent: { host: "192.168.1.77", port: 7437 } } }), { yes: true }), { only: ["config"] });
    const mine = jr(join(vladHome, "vlad.config.local.json")).machines.find((m: { name: string }) => m.name === "windows");
    expect(mine.roots).toEqual(["C:\\dev"]); expect(mine.kbDir).toBe("C:\\dev\\vlad-kb"); expect(mine.agent.bind).toBe("192.168.1.34");
    expect(mine.agent.host).toBe("192.168.1.77");
    expect(rs[0]!.actions.some((a) => a.kind === "print" && /192\.168\.1\.34/.test(a.what) && /192\.168\.1\.77/.test(a.what))).toBe(true);
  });
});

describe("compareDirs / yedek (P2-3)", () => {
  it("eksik + düzenlenmiş dosya birlikteyse 'eski' döner", async () => {
    const { compareDirs } = await import("../../src/setup/io.js");
    w(join(root, "s", "a.md"), "A"); w(join(root, "s", "b.md"), "B");
    w(join(root, "d", "b.md"), "B-edit"); // a.md eksik (önce gelir), b.md düzenlenmiş
    expect(compareDirs(join(root, "s"), join(root, "d"))).toBe("eski");
  });
  it("global skill: kısmi + düzenlenmiş yerel kopya ezilmeden önce yedeklenir", async () => {
    const src = join(vladHome, "global", "skills", "vlad-worker");
    const files = readdirSync(src);
    expect(files.length).toBeGreaterThan(0);
    const dst = join(claudeDir, "skills", "vlad-worker");
    w(join(dst, "SKILL.md"), "BENİM DÜZENLEMEM");
    await runSetup(ctx(ans(), { yes: true }), { only: ["global-skills"] });
    const baks = readdirSync(join(claudeDir, "vlad-backups"));
    expect(baks.length).toBe(1);
    expect(readFileSync(join(claudeDir, "vlad-backups", baks[0]!, "SKILL.md"), "utf8")).toBe("BENİM DÜZENLEMEM");
  });
  it("repo-skills: eksik ama var olan hedef yedeklenir", async () => {
    const dst = join(claudeDir, "skills", "impeccable");
    w(join(vladHome, ".claude", "skills", "impeccable", "extra.md"), "E");
    w(join(dst, "SKILL.md"), "impeccable");
    await runSetup(ctx(ans(), { yes: true }), { only: ["repo-skills"] });
    const baks = existsSync(join(claudeDir, "vlad-backups")) ? readdirSync(join(claudeDir, "vlad-backups")) : [];
    expect(baks.length).toBeGreaterThan(0);
    expect(existsSync(join(dst, "extra.md"))).toBe(true);
  });
});

describe("hook eşleşmesi sonekle, worktree'de reddet (P2-4)", () => {
  it("başka kök için kayıtlı session-report hook'u varsa ikinci hook eklenmez", async () => {
    const other = 'node "/baska/yer/vlad/dist/hooks/session-report.js"';
    w(settings(), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: other, timeout: 60 }] }] } }));
    await runSetup(ctx(ans(), { yes: true }), { only: ["hooks"] });
    const cmds = jr(settings()).hooks.SessionEnd.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toEqual([other]);
  });
  it("vladHome bir git worktree'siyse (.git dosyası) hook yazılmaz, açıklama basılır", async () => {
    w(join(vladHome, ".git"), "gitdir: /x/.git/worktrees/y");
    const rs = await runSetup(ctx(ans(), { yes: true }), { only: ["hooks"] });
    expect(existsSync(settings()) ? JSON.stringify(jr(settings())) : "").not.toContain("session-report");
    expect(rs[0]!.actions.some((a) => /worktree/i.test(a.what))).toBe(true);
  });
});
