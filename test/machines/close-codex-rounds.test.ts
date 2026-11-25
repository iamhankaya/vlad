import { describe, expect, it } from "vitest";
import { codexRoundsLine } from "../../src/machines/close.js";

const L = (m: string) => `- 2026-11-25T10:00:00+03:00 ${m}`;

describe("K5: Codex tur sayısını CLI sayar", () => {
  it("ara ve son tur notlarını satır başından sayar", () => {
    const body = [L("Codex ara turu: T1"), L("Codex ara turu: T2"), L("Codex son turu: düzeltme 1")].join("\n");
    expect(codexRoundsLine(body)).toBe("Codex turları: ara=2 son=1");
  });

  it("üretilen satırı vlad audit setup'ın yapısal sayacı okur", () => {
    const line = codexRoundsLine([L("Codex ara turu: T1"), L("Codex son turu: d1"), L("Codex son turu: d2")].join("\n"))!;
    const m = /^- \S+ Codex turları: ara=(\d+) son=(\d+)\s*$/m.exec(L(line)); // same pattern as src/audit/setup.ts
    expect(m?.slice(1)).toEqual(["1", "2"]);
  });

  it("tur yoksa 0/0 yazar", () => {
    expect(codexRoundsLine(L("başka not"))).toBe("Codex turları: ara=0 son=0");
  });

  it("alıntı/şablon metni sayılmaz (satır başına çıpalı)", () => {
    const body = [L("not: `Codex ara turu: <faz>` yazılır"), L("yorum Codex son turu: x"), "Codex ara turu: çıplak"].join("\n");
    expect(codexRoundsLine(body)).toBe("Codex turları: ara=0 son=0");
  });

  it("son yazılı toplam satırı aynıysa null (yeniden yazma yok)", () => {
    const body = [L("Codex ara turu: T1"), L("Codex turları: ara=1 son=0")].join("\n");
    expect(codexRoundsLine(body)).toBeNull();
  });

  it("tur eklenmişse eski toplamdan sonra yeni satır üretir", () => {
    const body = [L("Codex ara turu: T1"), L("Codex turları: ara=1 son=0"), L("Codex son turu: d1")].join("\n");
    expect(codexRoundsLine(body)).toBe("Codex turları: ara=1 son=1");
  });
});
