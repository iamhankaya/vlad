import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// approver-kabul KK8 (statik yarı): approver kaynağı gelen port açmaz (sunucu/dinleme yok). Dinamik yarı: approver-child.test.ts (lsof).
const SRC = resolve(import.meta.dirname, "..", "..", "src");
const files = [
  ...readdirSync(join(SRC, "approver")).filter((f) => f.endsWith(".ts")).map((f) => join(SRC, "approver", f)),
  join(SRC, "cli", "groups", "approver.ts"),
];
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("approver: gelen bağlantı yok (statik)", () => {
  it.each(files.map((f) => [f.slice(SRC.length + 1), f] as const))("%s sunucu/dinleme çağrısı içermez", (_n, f) => {
    const code = strip(readFileSync(f, "utf8"));
    expect(code).not.toMatch(/\.listen\s*\(/);
    expect(code).not.toMatch(/\b(createServer|createSecureServer|WebSocketServer|createSocket)\b/);
    expect(code).not.toMatch(/from\s+["']node:(net|http2|dgram)["']/);
  });
});
