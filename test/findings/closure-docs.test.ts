import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("bulgu kapatma sözleşmesi (skill metinleri)", () => {
  it("vlad-worker raporu `### Kapatılan bulgular` + tam ID kuralını içerir", () => {
    const t = read("global/skills/vlad-worker/SKILL.md");
    expect(t).toContain("### Kapatılan bulgular");
    expect(t).toMatch(/Tam ID zorunlu/);
    expect(t).toContain("F-014,017-024");
  });
  it("digest 4b: kapatmayı bu bölümden yapar, kısaltılmış ID'yi digest-pending'e taşır, benzer uyarısını işler", () => {
    const t = read(".claude/skills/digest/SKILL.md");
    expect(t).toContain("### Kapatılan bulgular");
    expect(t).toMatch(/genişletmeye çalışma/);
    expect(t).toContain("digest pending add");
    expect(t).toContain("similar");
  });
});
