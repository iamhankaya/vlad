import { describe, expect, it } from "vitest";
import { validateRequest } from "../../src/approver/request.js";

// T20261116-18: CONTROL genelleştirildi (\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp} − ASCII boşluk + seçili dolgu/varyasyon karakterleri).
const night = (note: string) => validateRequest({ v: 1, cid: "abcdefghijklmnopqrstuvwxyz", op: "mode night", argv: ["mode", "night", "--note", note], requestedAt: new Date().toISOString(), requester: "vlad" }).ok;

describe("CONTROL: görünmez/aldatıcı karakterler reddedilir, normal metin geçer", () => {
  it.each([0x202f, 0x00a0, 0x180b, 0x180c, 0x180d, 0x0600, 0x06dd, 0x070f, 0x08e2, 0x1d173, 0x2009, 0x205f, 0x3000, 0x2800, 0x034f, 0x17b4, 0xe0100, 0x115f, 0xffa0, 0xfe0f])("U+%s reddedilir", (cp) => {
    expect(night(`a${String.fromCodePoint(cp)}b`)).toBe(false);
  });
  it("Türkçe harfler, ASCII boşluk, rakam, noktalama ve birleşik harf serbest", () => {
    expect(night("gece işi ŞşİıĞğÜüÖöÇç - 12:30, ok!")).toBe(true);
  });
});
