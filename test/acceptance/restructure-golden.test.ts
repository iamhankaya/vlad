// Yeniden yapılanma kabulü (T20261105-62): taban bbe6ccd'nin gerçek CLI davranışı golden'a kaydedildi
// (`VLAD_GOLDEN_UPDATE=1 node scripts/golden-capture.mjs --base bbe6ccd`); burada geçerli `dist` aynı senaryolarla
// yeniden koşulur ve bire bir karşılaştırılır. Golden'lar yalnız bilinçli farkla değişir: `test/golden/intentional.json`
// girdileri `{id, keys[]}`; listelenen anahtar için fark hata sayılmaz (U4 bilinçli farkları, bulgu ID'siyle).
// Tüm senaryolar geçici dizinde ve allowlist env ile koşar; gerçek HOME/kb'ye dokunulmaz.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error düz JS yardımcı (scripts/lib), tür bildirimi yok
import { BEHAVIOR_CASES, CONTEXTS, captureBehavior, captureClasses, captureHelp, normalizer } from "../../scripts/lib/golden.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const CLI = resolve(root, "dist", "cli.js");
const readJson = (f: string) => JSON.parse(readFileSync(resolve(root, "test", "golden", f), "utf8"));
const intentional: Set<string> = new Set((readJson("intentional.json").entries as Array<{ id: string; keys: string[] }>).flatMap((e) => e.keys));
const dropIntentional = <T extends Record<string, unknown>>(o: T): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !intentional.has(k)));

describe("restructure: golden dosyaları sağlam (boş küme ya da eksik sayı ⇒ kırmızı)", () => {
  const classes = readJson("command-classes.json");
  it("command-classes: sabit üyeler ve alt sınır sayılar", () => {
    expect(classes.base).toBe("bbe6ccd");
    expect(classes.KB_WRITES.length).toBeGreaterThanOrEqual(32);
    expect(classes.KB_WRITES).toEqual(expect.arrayContaining(["task new", "task log", "project write", "mode status", "task resume", "task cleanup"]));
    expect(classes.REFRESH_KEYS.slice().sort()).toEqual(["decision add", "decision migrate", "decision set", "finding add", "finding set", "kb maintain", "project write", "task digested", "task set"]);
    expect(classes.INNER_LOCK.slice().sort()).toEqual(["task cleanup", "task resume"]);
    expect(Object.keys(classes.FORWARD).sort()).toEqual(["task ask", "task log", "task report", "task session"]);
    expect(classes.WORKER_LOCAL.length).toBeGreaterThanOrEqual(39);
    expect(classes.CONSOLE_CATALOG.length).toBeGreaterThanOrEqual(59);
  });
  it("help golden: her yaprak komutun --help'i ve grup (çıplak) yardımı var; Commander sürümü kilitli", () => {
    const h = readJson("help.json");
    expect(Object.keys(h.help).length).toBeGreaterThanOrEqual(115);
    expect(Object.keys(h.help).filter((k) => k.endsWith("(bare)")).length).toBeGreaterThanOrEqual(17);
    expect(h.commander).toMatch(/^\^?15/);
    expect(h.help["task log --help"].stdout).toContain("task log");
    expect(h.help["task (bare)"].code).toBe(1); // çıplak grup → stderr'e yardım, çıkış 1 (pendingHelp yolu)
    expect(h.help["task (bare)"].stderr).toContain("Commands:");
  });
  it("davranış matrisi: 6 bağlam × tüm vakalar, hiçbir hücre zaman aşımına düşmemiş", () => {
    const b = readJson("command-behavior.json");
    expect(b.contexts).toEqual(CONTEXTS);
    expect(Object.keys(b.matrix)).toHaveLength(CONTEXTS.length * BEHAVIOR_CASES.length);
    expect(Object.values(b.matrix as Record<string, { timedOut: boolean }>).filter((c) => c.timedOut)).toEqual([]);
  });
});

describe("restructure: normalizer takvim tarihinden bağımsız (T20261107-01)", () => {
  it("YYYY-MM-DD <DATE> olur; ISO zaman damgası ve görev ID'si kendi yer tutucusunu korur", () => {
    const n = normalizer({ base: "/b" }, 1234);
    expect(n("- 2026-11-05: ders / 2031-01-09")).toBe("- <DATE>: ders / <DATE>");
    expect(n("at 2026-11-05T10:00:00Z T20261105-53")).toBe("at <ISO> T<DATE>-53");
  });
});

describe("restructure: komut sınıfları taban ile eşdeğer", () => {
  it("KB_WRITES, REFRESH_KEYS, WORKER_LOCAL, FORWARD, INNER_LOCK, CONSOLE_CATALOG geçerli dist'ten üretilince golden ile aynı", async () => {
    const golden = readJson("command-classes.json");
    const { base: _b, ...expected } = golden;
    const now = await captureClasses(resolve(root, "dist"));
    expect(now).toEqual(expected);
  });
});

describe("restructure: --help golden", () => {
  it("her komutun yardımı ve grup yardımı (stdout/stderr/çıkış kodu) tabanla bire bir", () => {
    const expected = dropIntentional(readJson("help.json").help);
    const now = dropIntentional(captureHelp(CLI));
    expect(Object.keys(now).sort()).toEqual(Object.keys(expected).sort());
    expect(now).toEqual(expected);
  }, 240_000);
});

describe("restructure: komut × bağlam davranış matrisi (kilit, iletim, ret, çıktı) tabanla bire bir", () => {
  const golden = readJson("command-behavior.json");
  for (const ctx of CONTEXTS as string[]) {
    it(`bağlam ${ctx}`, async () => {
      const now = (await captureBehavior(CLI, root, [ctx])).matrix;
      const expected = Object.fromEntries(Object.entries(golden.matrix).filter(([k]) => k.startsWith(`${ctx} :: `)));
      expect(dropIntentional(now)).toEqual(dropIntentional(expected));
    }, 240_000);
  }
});

describe("restructure: davranış matrisinin kendisi sınıfları kanıtlar (golden okunabilir kalsın)", () => {
  const m = readJson("command-behavior.json").matrix as Record<string, { code: number | null; stderr: string; stdout: string; lockTimeout: boolean; forwardAttempt: boolean; rejected: boolean }>;
  it("kilitli kb: dış kilit komutları zaman aşımına düşer, okuma komutları ve iç kilitli olmayanlar düşmez", () => {
    for (const k of ["task new", "task log", "finding add", "project write", "decision add", "task set", "mode off", "mode status", "task resume", "task cleanup"]) {
      // resume/cleanup: machines yokken "outer" (bugünkü davranış)
      expect(m[`locked :: ${k}`]!.lockTimeout, k).toBe(true);
    }
    for (const k of ["task list", "finding list", "role list", "kb search", "status --no-mark", "project list"]) expect(m[`locked :: ${k}`]!.lockTimeout, k).toBe(false);
  });
  it("işçi: FORWARD komutları yerel Agent'a gider (75), kb yazıcılar reddedilir, yerel okumalar çalışır", () => {
    for (const k of ["task log", "task ask", "task session"]) expect(m[`worker :: ${k}`]).toMatchObject({ forwardAttempt: true, code: 75 });
    for (const k of ["project write", "task new", "finding add", "task set", "task launch", "task gate"]) expect(m[`worker :: ${k}`], k).toMatchObject({ rejected: true, code: 1 });
    for (const k of ["task list", "finding list", "role list", "inbox count", "status --no-mark"]) expect(m[`worker :: ${k}`]!.code, k).toBe(0);
  });
  it("unknown kimlik: kb yazıcı fail-closed reddedilir; yerel okuma çalışır", () => {
    for (const k of ["task new", "project write", "task log"]) expect(m[`unknown :: ${k}`], k).toMatchObject({ rejected: true, code: 1 });
    expect(m["unknown :: task list"]!.code).toBe(0);
  });
  it("VLAD_FORWARDED: işçi kimliği olsa da yeniden iletim yok, yerel handler çalışır", () => {
    for (const k of ["task log", "task ask", "task new"]) expect(m[`forwarded :: ${k}`], k).toMatchObject({ forwardAttempt: false, rejected: false });
  });
});

// ---- konsol kataloğu (negatif golden), zaman aşımı, bozuk config, üretim koruması ----
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isolatedEnv, spawnVlad } from "../support/spawn-vlad.js";

describe("restructure: konsol doğrulaması (validateConsoleArgv / consoleExecTimeoutMs) tabanla aynı", () => {
  const load = async () => (await import(pathToFileURL(resolve(root, "dist/agent/console-catalog.js")).href)) as {
    validateConsoleArgv: (a: string[], stdin?: string) => { entry: { path: string[] } };
    consoleExecTimeoutMs: (a: string[]) => number;
  };
  const code = (f: () => unknown): string => { try { f(); return "ok"; } catch (e) { return (e as { code?: string }).code ?? "error"; } };
  it("katalogdaki her yol kabul edilir; katalog dışı gruplar (agent, machine, queue, remote, install) ve bilinmeyen komut forbidden", async () => {
    const c = await load();
    const classes = readJson("command-classes.json");
    for (const e of classes.CONSOLE_CATALOG as Array<{ path: string[] }>) expect(code(() => c.validateConsoleArgv(e.path)), e.path.join(" ")).toBe("ok");
    for (const a of [["agent", "start"], ["machine", "list"], ["queue", "list"], ["remote", "--", "x"], ["install"], ["bilinmeyen"], []]) expect(code(() => c.validateConsoleArgv(a)), a.join(" ")).toBe("forbidden");
  });
  it("dosya bayrağı: yalnız '-' (stdin) kabul; gerçek yol, =yol ve katalog dışı --*-file forbidden; NUL ve dev argüman bad_request", async () => {
    const c = await load();
    expect(code(() => c.validateConsoleArgv(["project", "write", "p", "--file", "-"], "içerik"))).toBe("ok");
    expect(code(() => c.validateConsoleArgv(["project", "write", "p", "--file", "/etc/passwd"], "x"))).toBe("forbidden");
    expect(code(() => c.validateConsoleArgv(["project", "write", "p", "--file=/etc/passwd"], "x"))).toBe("forbidden");
    expect(code(() => c.validateConsoleArgv(["task", "log", "T1", "n", "--events-file", "-"], "x"))).toBe("forbidden");
    expect(code(() => c.validateConsoleArgv(["project", "write", "p", "--file", "-"]))).toBe("bad_request"); // stdin eksik
    expect(code(() => c.validateConsoleArgv(["task", "log", "T1", "a\0b"]))).toBe("bad_request");
    expect(code(() => c.validateConsoleArgv(["task", "log", "T1", "x".repeat(65 * 1024)]))).toBe("bad_request");
  });
  it("timeoutMs: gate 31 dk, merge 6 dk, diğerleri 110 sn", async () => {
    const c = await load();
    expect(c.consoleExecTimeoutMs(["task", "gate", "T1"])).toBe(31 * 60_000);
    expect(c.consoleExecTimeoutMs(["task", "merge", "T1"])).toBe(6 * 60_000);
    expect(c.consoleExecTimeoutMs(["task", "list"])).toBe(110_000);
  });
});

describe("restructure: config bozukken kilitsiz/yerel komutlar çalışmaya devam eder (tembel config)", () => {
  it("bozuk vlad.config.json ile role list, task list, finding list, kb search çıkış 0", () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-badcfg-")));
    try {
      const home = join(base, "home");
      for (const d of ["projects", "tasks", "inbox", "inbox/processed", "logs", "journal", "findings"]) mkdirSync(join(home, "kb", d), { recursive: true });
      cpSync(resolve(root, "schemas"), join(home, "schemas"), { recursive: true });
      writeFileSync(join(home, "vlad.config.json"), '{ "machines": [ ');
      writeFileSync(join(home, "vlad.local.json"), JSON.stringify({ self: "mac", keys: {} }));
      const env = isolatedEnv({ VLAD_HOME: home, VLAD_LOCAL_FILE: join(home, "vlad.local.json"), VLAD_CLAUDE_JSON: join(base, "c.json") });
      for (const args of [["role", "list", "--json"], ["task", "list", "--json"], ["finding", "list", "--json"], ["kb", "search", "x", "--json"]]) {
        const r = spawnVlad({ args, env, timeoutMs: 30_000 });
        expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 60_000);
});

describe("restructure: golden-capture üretim koruması", () => {
  it("VLAD_GOLDEN_UPDATE=1 olmadan golden'ı ezmeden çıkış 2 ile durur", () => {
    const r = spawnSync(process.execPath, [resolve(root, "scripts/golden-capture.mjs"), "--base", "bbe6ccd"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/VLAD_GOLDEN_UPDATE/);
  });
});
