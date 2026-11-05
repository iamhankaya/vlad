// Bağımsız güvenlik değişmezleri (T20261105-62; plan "Bağımsız güvenlik değişmezleri"): golden'dan ayrı, snapshot eşitliğinin
// yanlış sınıflamayı korumasına karşı. İki katman:
//  (A) taban sınıflama verisi (test/golden/command-classes.json) üzerinde: bugünkü sınıflama bu kuralları sağlıyor, yoksa golden'ın kendisi yanlış.
//  (B) manifest (COMMANDS) üzerinde: U1 dolduruncaya kadar KIRMIZI (manifest boş). Kırmızı bırakılan testler görev raporunda listelidir.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/commands/manifest.js";
import { keyOf, type CommandSpec } from "../../src/commands/types.js";

const classes = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "golden", "command-classes.json"), "utf8")) as {
  KB_WRITES: string[]; REFRESH_KEYS: string[]; WORKER_LOCAL: string[]; FORWARD: Record<string, string>; INNER_LOCK: string[];
  CONSOLE_CATALOG: Array<{ path: string[]; kind: "read" | "write" }>;
};
const key = (p: string[]) => (p.length === 1 ? `vlad ${p[0]}` : `${p[p.length - 2]} ${p[p.length - 1]}`);
const set = (a: string[]) => new Set(a);

// Gerekçeli istisnalar (elle onaylı): kb'ye outer kilitle yazmayan ama konsolda `write` olan komutlar kendi kilidini alır ya da kb'ye yazmaz.
const CONSOLE_WRITE_NOT_OUTER = ["task launch", "task close-window", "task gate", "task merge", "kb commit"]; // launch/gate/merge/commit: iç kilit; close-window: kb yazmaz
// `mode status` konsolda okuma, ama süresi dolan mod penceresini temizler (yan etki yazması): bilinçli ayrım. `vlad status` KB_WRITES'ta değil (özel dal).
const CONSOLE_READ_BUT_KB_WRITE = ["mode status"];

describe("s-invariants (A): taban sınıflaması", () => {
  const kb = set(classes.KB_WRITES), local = set(classes.WORKER_LOCAL), fwd = Object.keys(classes.FORWARD);
  it("kb yazıcı komut işçide yerel çalışmaz (yalnız iletilir ya da reddedilir)", () => {
    expect(classes.KB_WRITES.filter((k) => local.has(k))).toEqual([]);
  });
  it("iletilen komut kb yazıcıdır ve yerel listede değildir", () => {
    expect(fwd.filter((k) => !kb.has(k))).toEqual([]);
    expect(fwd.filter((k) => local.has(k))).toEqual([]);
  });
  it("iç kilit ve refresh kümeleri kb yazıcıların alt kümesidir (refresh ⇒ outer)", () => {
    expect(classes.INNER_LOCK.filter((k) => !kb.has(k))).toEqual([]);
    expect(classes.REFRESH_KEYS.filter((k) => !kb.has(k))).toEqual([]);
    expect(classes.REFRESH_KEYS.filter((k) => classes.INNER_LOCK.includes(k))).toEqual([]);
  });
  it("konsolda write olan komut ya kb kilitli yazıcıdır ya gerekçeli istisnadır; işçide yerel yalnız close-window", () => {
    const w = classes.CONSOLE_CATALOG.filter((e) => e.kind === "write").map((e) => key(e.path));
    expect(w.filter((k) => !kb.has(k)).sort()).toEqual([...CONSOLE_WRITE_NOT_OUTER].sort());
    expect(w.filter((k) => local.has(k))).toEqual(["task close-window"]);
  });
  it("konsolda read + kb yazma birleşimi yalnız allowlist'te", () => {
    const r = classes.CONSOLE_CATALOG.filter((e) => e.kind === "read").map((e) => key(e.path));
    expect(r.filter((k) => kb.has(k))).toEqual(CONSOLE_READ_BUT_KB_WRITE);
  });
});

describe("s-invariants (B): manifest — U1 dolduruncaya kadar kırmızı", () => {
  const specs: readonly CommandSpec[] = COMMANDS;
  it("manifest boş değil", () => {
    expect(specs.length).toBeGreaterThan(0);
  });
  it("her komutun worker politikası vardır; varsayılan reject (yalnız local/forward listelenenler)", () => {
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s.worker, s.path.join(" ")).toBeDefined();
    const nonReject = specs.filter((s) => s.worker.kind !== "reject").map(keyOf).sort();
    expect(nonReject).toEqual([...classes.WORKER_LOCAL, ...Object.keys(classes.FORWARD)].sort());
  });
  it("console.write olan komut kilit (ya da gerekçeli istisna) ve worker politikası olmadan olmaz", () => {
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs.filter((x) => x.console.kind === "write")) {
      const k = keyOf(s);
      if (CONSOLE_WRITE_NOT_OUTER.includes(k)) continue;
      expect(s.lock, k).not.toBe("none");
      expect(s.worker.kind, k).not.toBe("local");
    }
  });
  it("console.read + kb yazma (lock != none) yalnız allowlist'te", () => {
    expect(specs.length).toBeGreaterThan(0);
    const bad = specs.filter((s) => s.console.kind === "read" && s.lock !== "none").map(keyOf);
    expect(bad.sort()).toEqual([...CONSOLE_READ_BUT_KB_WRITE].sort());
  });
  it("refresh ⇒ lock outer; phased komutta refresh yok", () => {
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs.filter((x) => x.refresh)) expect(s.lock, keyOf(s)).toBe("outer");
    for (const s of specs.filter((x) => x.lock === "phased")) expect(s.refresh, keyOf(s)).toBe(false);
  });
  it("hiçbir local/forward olmayan komut işçide yerel çalışmaz: iletilenin op'u dolu", () => {
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) if (s.worker.kind === "forward") expect(s.worker.op, keyOf(s)).toMatch(/^task\./);
  });
});
