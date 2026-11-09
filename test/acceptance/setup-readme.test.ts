// Kabul (T20261110-04; spec T20261110-02) S15: README "yeni makine / arkadaş kurulumu" kılavuzu. Uygulama 4e gelene dek KIRMIZI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(join(import.meta.dirname, "..", "..", "README.md"), "utf8");
const section = (): string => {
  const m = /^#{1,3}\s+.*(yeni makine|arkadaş).*$/im.exec(readme);
  if (!m) return "";
  const rest = readme.slice(m.index + m[0].length);
  const next = /^#{1,2}\s/m.exec(rest);
  return m[0] + (next ? rest.slice(0, next.index) : rest);
};

describe("S15: README kurulum kılavuzu", () => {
  it("'yeni makine / arkadaş kurulumu' bölümü var", () => { expect(section()).not.toBe(""); });
  it("dört komut: clone, npm i, npm run build, node dist/cli.js setup (+ --check)", () => {
    const s = section();
    for (const c of ["git clone", "npm i", "npm run build", "dist/cli.js setup", "setup --check"]) expect(s, c).toContain(c);
  });
  it("tek makine (S1), Windows (S2) ve çok makine --join/--add-worker (S8) adımları", () => {
    const s = section();
    expect(s).toMatch(/tek makine/i);
    expect(s).toMatch(/windows/i);
    expect(s).toContain("--join");
    expect(s).toContain("--add-worker");
  });
  it("Windows yolları C:\\dev varsayımı içermez ve kb repo adı kullanıcıya özel değil", () => {
    expect(readme).not.toContain("C:\\dev\\vlad");
    expect(readme).not.toContain("iamhankaya/vlad-kb");
  });
});
