// Yeniden yapılanma kabulü (T20261105-62): taban bbe6ccd'nin gerçek CLI davranışı golden'a kaydedildi
// (`VLAD_GOLDEN_UPDATE=1 node scripts/golden-capture.mjs --base bbe6ccd`); burada geçerli `dist` aynı senaryolarla
// yeniden koşulur ve bire bir karşılaştırılır. Golden'lar yalnız bilinçli farkla değişir: `test/golden/intentional.json`
// girdileri `{id, keys[]}`; listelenen anahtar için fark hata sayılmaz (U4 bilinçli farkları, bulgu ID'siyle).
// Tüm senaryolar geçici dizinde ve allowlist env ile koşar; gerçek HOME/kb'ye dokunulmaz.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error düz JS yardımcı (scripts/lib), tür bildirimi yok
import { BEHAVIOR_CASES, CONTEXTS, captureBehavior, captureClasses, captureHelp } from "../../scripts/lib/golden.mjs";

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
    expect(classes.REFRESH_KEYS.slice().sort()).toEqual(["decision add", "decision set", "finding add", "finding set", "project write", "task set"]);
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
