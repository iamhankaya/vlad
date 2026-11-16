import { describe, expect, it } from "vitest";
import { usedDir } from "../../src/mode/token.js";

// vmt2: U1 bu dosyayı VMT2 senaryolarıyla doldurur (tüketim, argv bağı, VMT1 regresyonu, process.env temizliği). Sözleşme fazında yalnız yer tutucu + ad alanı.
describe("vmt2: ad alanı (sözleşme yer tutucusu)", () => {
  it("tüketim kayıtları approver/ dışında, gizli dizin altında 'used' dizinidir", () => {
    expect(usedDir().replace(/\\/g, "/").endsWith("/used")).toBe(true);
  });
});
