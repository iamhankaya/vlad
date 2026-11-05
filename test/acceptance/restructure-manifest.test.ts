// Manifest tamlığı ve sınıf eşdeğerliği (T20261105-62). Manifest (`src/commands/manifest.ts`, U1) dolduruncaya kadar KIRMIZI:
// bu testler sözleşmeye (T20261105-69 "Arayüzler") göre yazıldı, uygulamanın içine bakmaz. Beklenen sınıflar taban golden'ından gelir;
// yaprak envanteri gerçek Commander ağacından (`scripts/list-commands.mjs`) çıkarılır, elle yazılmaz.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/commands/manifest.js";
import { keyOf, legacyKey, validateManifest } from "../../src/commands/types.js";

const root = resolve(import.meta.dirname, "..", "..");
const golden = JSON.parse(readFileSync(resolve(root, "test/golden/command-classes.json"), "utf8")) as {
  KB_WRITES: string[]; REFRESH_KEYS: string[]; WORKER_LOCAL: string[]; FORWARD: Record<string, string>; INNER_LOCK: string[];
  CONSOLE_CATALOG: Array<{ path: string[]; kind: "read" | "write"; fileFlags?: string[] }>;
};
const leaves = (): string[][] => {
  const r = spawnSync(process.execPath, [resolve(root, "scripts/list-commands.mjs")], { encoding: "utf8", timeout: 30_000 });
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { commands: Array<{ path: string[] }> }).commands.map((c) => c.path);
};
const sorted = (a: Iterable<string>) => [...a].sort();

describe("restructure-manifest: tamlık", () => {
  it("manifest boş değil", () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
  });
  it("validateManifest(COMMANDS, Commander yaprakları) hatasız: iki yönlü tamlık, anahtar çakışması yok", () => {
    expect(validateManifest(COMMANDS, leaves())).toEqual([]);
  });
  it("manifest yaprak sayısı koddan çıkarılan envanterle aynı (remote ve agent* dahil)", () => {
    const l = leaves();
    expect(l.length).toBeGreaterThanOrEqual(80);
    expect(sorted(COMMANDS.map((s) => s.path.join(" ")))).toEqual(sorted(l.map((p) => p.join(" "))));
  });
  it("remote 'plain' kayıtlıdır, vlad status tek 'status' dalıdır", () => {
    expect(COMMANDS.find((s) => s.path.join(" ") === "remote")?.registration).toBe("plain");
    expect(COMMANDS.filter((s) => s.exec === "status").map((s) => s.path.join(" "))).toEqual(["status"]);
  });
  it("legacyKey çakışması olan komut elle key taşır", () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
    const byLegacy = new Map<string, number>();
    for (const s of COMMANDS) byLegacy.set(legacyKey(s.path), (byLegacy.get(legacyKey(s.path)) ?? 0) + 1);
    for (const s of COMMANDS) if ((byLegacy.get(legacyKey(s.path)) ?? 0) > 1) expect(s.key, s.path.join(" ")).toBeTruthy();
  });
});

describe("restructure-manifest: sınıflar eski davranışla bire bir (taban golden'ı)", () => {
  const keys = () => new Set(COMMANDS.map(keyOf));
  it("golden'daki her anahtar gerçek bir manifest komutuna denk gelir (hayalet anahtar yok)", () => {
    const k = keys();
    const all = [...golden.KB_WRITES, ...golden.REFRESH_KEYS, ...golden.WORKER_LOCAL, ...Object.keys(golden.FORWARD), ...golden.INNER_LOCK];
    expect(k.size).toBeGreaterThan(0);
    expect(all.filter((x) => !k.has(x))).toEqual([]);
  });
  it("kb yazıcı kümesi: lock != none", () => {
    expect(sorted(COMMANDS.filter((s) => s.lock !== "none").map(keyOf))).toEqual(sorted(golden.KB_WRITES));
  });
  it("iç kilit kümesi: lock === phased", () => {
    expect(sorted(COMMANDS.filter((s) => s.lock === "phased").map(keyOf))).toEqual(sorted(golden.INNER_LOCK));
  });
  it("refresh kümesi", () => {
    expect(sorted(COMMANDS.filter((s) => s.refresh).map(keyOf))).toEqual(sorted(golden.REFRESH_KEYS));
  });
  it("işçide yerel kümesi", () => {
    expect(sorted(COMMANDS.filter((s) => s.worker.kind === "local").map(keyOf))).toEqual(sorted(golden.WORKER_LOCAL));
  });
  it("iletim haritası (anahtar → op)", () => {
    const m = Object.fromEntries(COMMANDS.flatMap((s) => (s.worker.kind === "forward" ? [[keyOf(s), s.worker.op]] : [])));
    expect(Object.keys(m).sort()).toEqual(Object.keys(golden.FORWARD).sort());
    expect(m).toEqual(golden.FORWARD);
  });
  it("konsol kataloğu: yol, tür ve dosya bayrakları aynı; katalog dışı komutlar console none + gerekçe", () => {
    const inCat = COMMANDS.filter((s) => s.console.kind !== "none");
    const cat = inCat.map((s) => ({ path: [...s.path], kind: s.console.kind, ...(s.console.kind !== "none" && s.console.fileFlags ? { fileFlags: s.console.fileFlags } : {}) }));
    const key = (e: { path: string[] }) => e.path.join(" ");
    expect(cat.sort((a, b) => key(a).localeCompare(key(b)))).toEqual([...golden.CONSOLE_CATALOG].sort((a, b) => key(a).localeCompare(key(b))));
    for (const s of COMMANDS.filter((x) => x.console.kind === "none")) expect(s.console.kind === "none" && s.console.reason.trim().length > 0, s.path.join(" ")).toBe(true);
  });
  it("hariç tutulan gruplar (agent, machine, queue, remote, install) konsolda yok", () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
    for (const s of COMMANDS.filter((x) => ["agent", "machine", "queue", "remote", "install"].includes(x.path[0]!))) expect(s.console.kind, s.path.join(" ")).toBe("none");
  });
});
