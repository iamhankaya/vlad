import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readText } from "../skill-text.js";

// T20261117-17: scale/recurrence rules from the T20261117-15 architecture audit live in role and skill texts.
const root = resolve(import.meta.dirname, "..", "..");
const role = (slug: string) => readFileSync(resolve(root, "roles", `${slug}.md`), "utf8");
const skill = (name: string) => readText(resolve(root, ".claude", "skills", name, "SKILL.md"));

describe("recurrence and scale rules (T20261117-17)", () => {
  it("developer: recurring class line, third-fix helper, spread (8 files / 3rd time) and the existing no-early-abstraction rule", () => {
    const t = role("developer");
    expect(t).toContain("tekrarlayan sınıf: <ad>, önceki: <commit/ID>");
    expect(t).toMatch(/üçüncü düzeltmede ortak yardımcıyı çıkar/i);
    expect(t).toContain("8'den fazla dosyaya");
    expect(t).toContain("kayıt tablosu");
    expect(t).toContain("yeni soyutlamayı ancak gerçekten gerekiyorsa ekle");
  });

  it("architect: exposure internet state table and data-access-path/index table", () => {
    const t = role("architect");
    expect(t).toContain("exposure: internet");
    expect(t).toMatch(/süreç içi durum, günlük bütçe, kuyruk, sağlayıcı kotası/);
    expect(t).toMatch(/hangi sayıda kırılır/);
    expect(t).toMatch(/veri erişim yolu ↔ indeks/i);
  });

  it("tester: derived invariant instead of pinning the last element or count", () => {
    expect(role("tester")).toMatch(/son elemanı ya da sayımı sabitleyen/);
    expect(role("tester")).toMatch(/türetilmiş değişmez/i);
  });

  it("analyst: documented deliberate limit is 'trigger + decision record', not 'risk'", () => {
    expect(role("analyst")).toMatch(/tetikleyici \+ karar kaydı/);
  });

  it("digest records 'tekrarlayan sınıf:' lines as orta findings; bulgu-tarama prioritises them", () => {
    expect(skill("digest")).toMatch(/tekrarlayan sınıf:[^\n]*orta/);
    expect(skill("bulgu-tarama")).toMatch(/tekrarlayan sınıf/);
  });
});
