import { describe, expect, it } from "vitest";
import { downloadsDir, isXferId, sanitizeEntryPath, uniqueName, XferPathError } from "../../src/transfer/paths.js";

const ok = (raw: string, os: "darwin" | "win32" = "darwin") => sanitizeEntryPath(raw, os);

describe("A1.1 sanitizeEntryPath", () => {
  it("geçerli yollar bileşenlere bölünür", () => {
    expect(ok("a.txt")).toEqual(["a.txt"]);
    expect(ok("dir/sub/f.bin")).toEqual(["dir", "sub", "f.bin"]);
    expect(ok("a b/ç ş.txt")).toEqual(["a b", "ç ş.txt"]);
    expect(ok(".env")).toEqual([".env"]);
  });
  it("NFD girdi NFC'ye normalleştirilir", () => {
    expect(ok("e\u0301.txt")).toEqual(["\u00e9.txt"]);
  });
  const bad: [string, string, ("darwin" | "win32")?][] = [
    ["", "boş yol"], ["/abs", "mutlak"], ["a//b", "boş bileşen"], ["a/", "boş bileşen"], [".", "nokta"], ["..", "üst dizin"], ["a/../b", "üst dizin"], ["./a", "nokta"],
    ["a\\b", "ters eğik"], ["C:\\x", "ters eğik"], ["a:b", "iki nokta (ADS)"], ["C:foo", "iki nokta"], ["a\u0000b", "denetim karakteri"], ["a\nb", "denetim karakteri"], ["a\u202eb", "yön geçersiz kılma"],
    [".vlad-incoming/x", "ayrılmış ad"], [".VLAD-INCOMING", "ayrılmış ad"], [".vlad-incoming", "ayrılmış ad"],
    ["a".repeat(256), "bileşen uzun"], [Array(33).fill("d").join("/"), "derinlik"], [Array(60).fill("abcd").join("/").slice(0, 0) + "x".repeat(100) + "/" + "y".repeat(100) + "/" + "z".repeat(100), "toplam uzun"],
    ["é".repeat(130), "bileşen uzun (bayt)"],
    ["CON", "ayrılmış ad", "win32"], ["con.txt", "ayrılmış ad", "win32"], ["CON.tar.gz", "ayrılmış ad", "win32"], ["d/NUL", "ayrılmış ad", "win32"], ["COM1", "ayrılmış ad", "win32"], ["COM\u00b9", "ayrılmış ad", "win32"], ["lpt9.x", "ayrılmış ad", "win32"],
    ["a.", "sondaki nokta", "win32"], ["a ", "sondaki boşluk", "win32"], ["a<b", "yasak karakter", "win32"], ["a?b", "yasak karakter", "win32"], ["a*b", "yasak karakter", "win32"], ['a"b', "yasak karakter", "win32"], ["a|b", "yasak karakter", "win32"],
  ];
  for (const [raw, why, os] of bad) {
    it(`reddeder: ${JSON.stringify(raw.length > 40 ? raw.slice(0, 20) + "…" : raw)} (${why}, ${os ?? "darwin"})`, () => {
      let err: unknown;
      try { ok(raw, os ?? "darwin"); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(XferPathError);
      expect((err as XferPathError).code).toBe("bad_request");
      expect((err as XferPathError).message).toMatch(/^bad_request: yol geçersiz: /);
    });
  }
  it("Windows kuralları darwin'de uygulanmaz (CON, sondaki nokta)", () => {
    expect(ok("CON")).toEqual(["CON"]);
    expect(ok("a.")).toEqual(["a."]);
  });
  it("sınırda geçerli: toplam 240 (bileşen sınırı toplamın içinde), derinlik 32", () => {
    expect(ok("a".repeat(240))).toHaveLength(1);
    expect(ok(Array(32).fill("d").join("/"))).toHaveLength(32);
  });
});

describe("A1.1 isXferId", () => {
  it("yalnız 32 küçük harf hex", () => {
    expect(isXferId("0123456789abcdef0123456789abcdef")).toBe(true);
    for (const b of ["", "../x", "0123456789ABCDEF0123456789ABCDEF", 5, null, undefined, {}]) expect(isXferId(b)).toBe(false);
  });
});

describe("A1.1 uniqueName", () => {
  const existing = (names: string[]) => async (c: string) => names.map((n) => n.toLowerCase()).includes(c.toLowerCase());
  it("çakışma yoksa aynı ad", async () => { expect(await uniqueName("a.txt", existing([]))).toBe("a.txt"); });
  it("ad (1).ext, ad (2).ext", async () => {
    expect(await uniqueName("a.txt", existing(["a.txt"]))).toBe("a (1).txt");
    expect(await uniqueName("a.txt", existing(["a.txt", "a (1).txt"]))).toBe("a (2).txt");
  });
  it(".env -> .env (1); a.tar.gz -> a.tar (1).gz; uzantısız", async () => {
    expect(await uniqueName(".env", existing([".env"]))).toBe(".env (1)");
    expect(await uniqueName("a.tar.gz", existing(["a.tar.gz"]))).toBe("a.tar (1).gz");
    expect(await uniqueName("noext", existing(["noext"]))).toBe("noext (1)");
  });
  it("dizin: uzantı bölünmez", async () => {
    expect(await uniqueName("d.v2", existing(["d.v2"]), "dir")).toBe("d.v2 (1)");
  });
  it("harf duyarsız karşılaştırmayı exists'e bırakır (çağıran küçük harfli küme verir)", async () => {
    expect(await uniqueName("A.txt", existing(["a.txt"]))).toBe("A (1).txt");
  });
  it("sonsuz döngüye girmez", async () => {
    await expect(uniqueName("a", async () => true)).rejects.toThrow(/failed/);
  });
});

describe("A1.1 downloadsDir", () => {
  it("VLAD_DOWNLOADS_DIR > win32 USERPROFILE > darwin ~/Downloads", () => {
    expect(downloadsDir("darwin", { VLAD_DOWNLOADS_DIR: "/x/y" })).toBe("/x/y");
    expect(downloadsDir("win32", { USERPROFILE: "C:\\Users\\u" })).toBe("C:\\Users\\u\\Downloads");
    expect(downloadsDir("darwin", { HOME: "/Users/u" })).toMatch(/Downloads$/);
  });
});

describe("A1 inceleme: ek ret kuralları", () => {
  for (const [raw, os] of [["CONIN$", "win32"], ["conout$.txt", "win32"], ["NUL .txt", "win32"], ["a‎b", "darwin"], ["a‏b", "darwin"]] as const)
    it(`reddeder ${JSON.stringify(raw)} (${os})`, () => { expect(() => sanitizeEntryPath(raw, os)).toThrow(XferPathError); });
});
