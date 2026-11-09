import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNPARSED_RED, compareBase, parseRedTests, type BaseEntry } from "../../src/tasks/gate-compare.js";
import { runBaseGate } from "../../src/agent/ops/gate.js";
import type { GateRunResult } from "../../src/fleet/types.js";

const H1 = "a".repeat(40), H2 = "b".repeat(40);
const red = (...names: string[]): string => names.map((n) => ` FAIL  ${n}`).join("\n");
const res = (exit: number, stdout = "", head?: string, extra: Partial<GateRunResult> = {}): GateRunResult => ({ exit, stdout, stderr: "", ...(head ? { head } : {}), ...extra });

/** Bellek içi önbellek + sayaçlı sahte koşucular. */
function harness(taskRes: GateRunResult, baseRes: (cachedHead?: string) => GateRunResult, cached: BaseEntry | null = null) {
  const store = { entry: cached };
  const calls = { task: 0, base: [] as (string | undefined)[] };
  return {
    store, calls,
    deps: {
      runTask: async () => { calls.task++; return taskRes; },
      runBase: async (cachedHead?: string) => { calls.base.push(cachedHead); return baseRes(cachedHead); },
      readCache: () => store.entry,
      writeCache: (e: BaseEntry) => { store.entry = e; },
      now: () => new Date("2026-11-10T00:00:00Z"),
    },
  };
}

describe("parseRedTests", () => {
  it("vitest FAIL satırlarını ANSI/süre sonekinden arındırıp tekrarsız verir", () => {
    const out = [
      "\u001b[31m FAIL \u001b[39m test/a.test.ts > suite > one 12ms",
      " ✓ test/b.test.ts > ok",
      " FAIL  test/a.test.ts > suite > one",
      " FAIL  test/c.test.ts [ test/c.test.ts ]",
    ].join("\n");
    expect(parseRedTests(out)).toEqual(["test/a.test.ts > suite > one", "test/c.test.ts [ test/c.test.ts ]"]);
  });
  it("kırmızı yoksa boş", () => expect(parseRedTests(" Test Files  3 passed\n")).toEqual([]));
});

describe("compareBase", () => {
  it("görev yeşil: taban koşulmaz, newRed boş", async () => {
    const h = harness(res(0, "", H1), () => res(0, "", H2));
    const r = await compareBase(h.deps);
    expect(r.newRed).toEqual([]);
    expect(h.calls.base).toEqual([]);
  });

  it("yeni kırmızı: yalnız görevde kırmızı olan test newRed; tabandaki baselineRed", async () => {
    const h = harness(res(1, red("t.ts > a", "t.ts > b"), H1), () => res(1, red("t.ts > b"), H2));
    const r = await compareBase(h.deps);
    expect(r.newRed).toEqual(["t.ts > a"]);
    expect(r.baselineRed).toEqual(["t.ts > b"]);
    expect(r.baselineSha).toBe(H2);
    expect(r.exit).toBe(1);
  });

  it("yalnız taban kırmızısı: newRed boş, çıkış 0 ve sonuç önbelleğe yazılır", async () => {
    const h = harness(res(1, red("t.ts > b"), H1), () => res(1, red("t.ts > b"), H2));
    const r = await compareBase(h.deps);
    expect(r.newRed).toEqual([]);
    expect(r.exit).toBe(0);
    expect(r.gateExit).toBe(1);
    expect(h.store.entry).toMatchObject({ head: H2, exit: 1, red: ["t.ts > b"] });
  });

  it("önbellekteki taban hâlâ hedef dal ucuysa yeniden koşulmaz (işçi cached döner)", async () => {
    const cached: BaseEntry = { head: H2, exit: 1, red: ["t.ts > b"], at: "2026-11-09T00:00:00Z" };
    const h = harness(res(1, red("t.ts > b", "t.ts > c"), H1), (ch) => res(0, "", ch, { cached: true }), cached);
    const r = await compareBase(h.deps);
    expect(h.calls.base).toEqual([H2]); // işçiye sha verilir, uç ile karşılaştırma orada
    expect(r.baselineCached).toBe(true);
    expect(r.newRed).toEqual(["t.ts > c"]);
    expect(r.baselineRed).toEqual(["t.ts > b"]);
  });

  it("bayat taban: hedef dal ilerledi → taban yeniden koşulur, eski kırmızı yeni sonucu etkilemez", async () => {
    const cached: BaseEntry = { head: H1, exit: 1, red: ["t.ts > b"], at: "2026-11-09T00:00:00Z" };
    // eski önbellekte b kırmızıydı; yeni uçta b düzelmiş, görevde b kırmızı → yeni kırmızı sayılmalı
    const h = harness(res(1, red("t.ts > b"), "c".repeat(40)), () => res(0, "", H2), cached);
    const r = await compareBase(h.deps);
    expect(r.baselineCached).toBe(false);
    expect(r.baselineSha).toBe(H2);
    expect(r.newRed).toEqual(["t.ts > b"]);
    expect(h.store.entry).toMatchObject({ head: H2, exit: 0, red: [] });
  });

  it("görev kırmızı ama test adı ayrıştırılamadı (build/zaman aşımı): newRed işaretli, yeşil sanılmaz", async () => {
    const h = harness(res(2, "tsc error", H1), () => res(0, "", H2));
    const r = await compareBase(h.deps);
    expect(r.newRed).toEqual([UNPARSED_RED]);
    expect(r.exit).toBe(1);
  });

  it("taban kırmızı ama adlar ayrıştırılamadı: hiçbir görev kırmızısı taban sayılmaz", async () => {
    const h = harness(res(1, red("t.ts > a"), H1), () => res(2, "build patladı", H2));
    const r = await compareBase(h.deps);
    expect(r.newRed).toEqual(["t.ts > a"]);
    expect(r.baselineRed).toEqual([]);
  });

  it("işçi tabanda head vermezse (ör. HEAD değişti) hata", async () => {
    const h = harness(res(1, red("x"), H1), () => res(1, red("x")));
    await expect(compareBase(h.deps)).rejects.toThrow(/taban/);
  });
});

describe("runBaseGate (işçi tarafı, geçici git deposunda)", () => {
  function repo(): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "vlad-gcb-")));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "pipe" });
    g("init", "-q", "-b", "master"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
    writeFileSync(join(d, "f"), "1"); g("add", "."); g("commit", "-qm", "c1");
    return d;
  }
  const headOf = (d: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: d }).toString().trim();

  it("dal ucunda gate'i koşar, head döner", async () => {
    const d = repo();
    try {
      const r = await runBaseGate(d, "master", undefined, "echo hi");
      expect(r.exit).toBe(0);
      expect(r.head).toBe(headOf(d));
      expect(r.cached).toBeUndefined();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("cachedHead uçla aynıysa gate koşmaz (cached:true); farklıysa koşar", async () => {
    const d = repo();
    try {
      const marker = join(d, "ran");
      const cmd = process.platform === "win32" ? `echo x> "${marker}"` : `touch '${marker}'`;
      const r1 = await runBaseGate(d, "master", headOf(d), cmd);
      expect(r1).toMatchObject({ exit: 0, cached: true, head: headOf(d) });
      expect(() => execFileSync("git", ["status", "--porcelain"], { cwd: d })).not.toThrow();
      const r2 = await runBaseGate(d, "master", H1, `exit 3`);
      expect(r2.exit).toBe(3);
      expect(r2.cached).toBeUndefined();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("dizin hedef dalda değilse ya da izlenen dosya kirliyse reddeder (başkasının işine dokunma)", async () => {
    const d = repo();
    try {
      await expect(runBaseGate(d, "vlad/T20261110-99", undefined, "echo hi")).rejects.toThrow(/dalında değil/);
      writeFileSync(join(d, "f"), "kirli");
      await expect(runBaseGate(d, "master", undefined, "echo hi")).rejects.toThrow(/kirli/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
