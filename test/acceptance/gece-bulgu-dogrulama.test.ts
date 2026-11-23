// T20261123-19 (doğrulama fazı): gece bulgu turunun (T20261123-18) düzeltmelerine karşı hata avı.
// Saf fonksiyonlar; gerçek dosya sistemi/hesap yok. `it.fails` = hatayı kanıtlayan, gate'i kırmızı yapmayan
// kasıtlı kırmızı test (düzeltilince `it.fails` başarısız olur ve `it`e çevrilir).
import { describe, expect, it } from "vitest";
import { partialFindingTokens } from "../../src/findings/closed-report.js";
import { hasRiskyQuantifiedGroup } from "../../src/agent/scripts/manifest.js";

const section = (line: string) => `### Kapatılan bulgular\n${line}\n### Açık noktalar\n`;

describe("F-vlad-334 kısmi/kısmı ayrımı (davranış sınırı)", () => {
  it("kısmi (küçük/baş harf, ASCII, İ) kısmi sayılır; kısmı (the part) sayılmaz", () => {
    for (const w of ["kısmi", "Kısmi", "kismi", "Kismi", "KISMİ"]) {
      expect(partialFindingTokens(section(`- F-vlad-001 — ${w} düzeltme`)), w).toEqual(["F-vlad-001"]);
    }
    for (const w of ["kısmı", "Kısmı"]) {
      expect(partialFindingTokens(section(`- F-vlad-001 — ${w} düzeldi`)), w).toEqual([]);
    }
  });
  // Hata: tümü büyük ASCII `KISMI` tr küçük harfinde `kısmı` olur → kısmi kapanış tam kapanış sayılır, bulgu yanlışlıkla kapanır.
  it("BÜYÜK ASCII `KISMI` kısmi sayılır (şu an kapatma yolunda tam sayılıyor)", () => {
    expect(partialFindingTokens(section("- F-vlad-001 — KISMI düzeltme"))).toEqual(["F-vlad-001"]);
  });
  // Hata: şapkalı `kısmî` ne `kısmi` ne `kismi` eşleşir.
  it("şapkalı `kısmî` kısmi sayılır", () => {
    expect(partialFindingTokens(section("- F-vlad-001 — kısmî düzeltme"))).toEqual(["F-vlad-001"]);
  });
  it("kismiydi/kısmidir/kısmî/KISMI/Kısmî kısmi sayılır (T20261123-35)", () => {
    for (const w of ["kismiydi", "kısmidir", "kısmî", "KISMI", "Kısmî", "KISMIDIR"]) {
      expect(partialFindingTokens(section(`- F-vlad-001 — ${w} düzeltme`)), w).toEqual(["F-vlad-001"]);
    }
  });
  it("küçük harf kısmı ve ekleri kısmi sayılmaz", () => {
    for (const w of ["kısmı", "kısmını", "kısmıdır"]) {
      expect(partialFindingTokens(section(`- F-vlad-001 — ${w} düzeldi`)), w).toEqual([]);
    }
  });
});

describe("F-vlad-288 ReDoS ön taraması (sınır davranışı)", () => {
  it("üstel biçimler reddedilir", () => {
    for (const p of ["(a+)+", "(a*)*", "(a|aa)+", "(a?)*", "(\\.+)*", "(a+){2}", "(a{2,3})+", "(?:a+)+", "(?i:a+)+", "(?<n>a+)+", "((a+))+", "((\\.\\d+)*)*", "(\\w+\\s?)+", "(a+)*?", "(a+)++"]) {
      expect(hasRiskyQuantifiedGroup(p), p).toBe(true);
    }
  });
  it("sürüm/ayraçlı güvenli biçimler kabul edilir", () => {
    for (const p of ["\\d+(\\.\\d+)*", "(\\.\\d+)*", "(-\\w+)*", "(,\\s*\\w+)*", "(a+){1}", "(a+)?", "[(]a+[)]+", "\\(a+\\)+", "(a+)(b+)"]) {
      expect(hasRiskyQuantifiedGroup(p), p).toBe(false);
    }
  });
  it("kabul edilen desenler kötü girdide hızlı biter (gerçek eşleşme, geniş pay)", () => {
    // Duvar saati eşiği: yük altında bile üstel patlamayı (≫ saniyeler) yakalamak için 2 sn pay.
    for (const p of ["\\d+(\\.\\d+)*", "(-\\w+)*", "(,\\s*\\w+)*"]) {
      const re = new RegExp(`^(?:${p})$`);
      const t0 = Date.now();
      re.test("1" + ".1".repeat(5000) + "!");
      re.test("-a".repeat(5000) + "!");
      re.test(",a".repeat(5000) + "!");
      expect(Date.now() - t0, p).toBeLessThan(2000);
    }
  });
});
