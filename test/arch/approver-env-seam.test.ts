import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// approver-kabul: üretim approver kodu VLAD_* env'inden test seam'i OKUMAZ (sahte ntfy/saat/yürütücü yalnız DI ile; env kaçışı korunan işlemi atlatır).
const SRC = resolve(import.meta.dirname, "..", "..", "src");
const files = [
  ...readdirSync(join(SRC, "approver")).filter((f) => f.endsWith(".ts")).map((f) => join(SRC, "approver", f)),
  join(SRC, "cli", "groups", "approver.ts"),
];
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("approver: env seam yok", () => {
  it.each(files.map((f) => [f.slice(SRC.length + 1), f] as const))("%s process.env'den VLAD_* okumaz", (_n, f) => {
    const code = strip(readFileSync(f, "utf8"));
    expect(code).not.toMatch(/process\.env\.VLAD_\w+/);
    expect(code).not.toMatch(/process\.env\[\s*["'`]VLAD_/);
  });
});
