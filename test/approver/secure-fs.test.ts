import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAME_RE, assertSecretParentSecure, assertSecureDir, readSecureFile, writeAtomic } from "../../src/mode/secure-fs.js";

// approver: secure-fs (T20261116-04 sözleşme): gerçek uygulama; yalnız geçici dizinde koşar.
const posix = process.platform !== "win32";
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-sfs-"))); chmodSync(root, 0o700); });
afterEach(() => { if (root.startsWith(realpathSync(tmpdir()))) rmSync(root, { recursive: true, force: true }); });

describe.runIf(posix)("approver: assertSecureDir", () => {
  it("yoksa 0700 oluşturur, varsa dokunmaz", () => {
    const d = join(root, "a");
    assertSecureDir(d);
    expect(lstatSync(d).mode & 0o777).toBe(0o700);
    assertSecureDir(d);
  });
  it("sembolik bağı, dosyayı ve geniş izni reddeder", () => {
    const real = join(root, "real"); mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(root, "link"));
    expect(() => assertSecureDir(join(root, "link"))).toThrow(/sembolik/);
    writeFileSync(join(root, "f"), "x");
    expect(() => assertSecureDir(join(root, "f"))).toThrow(/dizin/);
    const wide = join(root, "wide"); mkdirSync(wide); chmodSync(wide, 0o755);
    expect(() => assertSecureDir(wide)).toThrow(/0700/);
  });
  it("üst dizin başkası tarafından yazılabilirse (sticky değil) reddeder", () => {
    const bad = join(root, "bad"); mkdirSync(bad); chmodSync(bad, 0o777);
    expect(() => assertSecureDir(join(bad, "child"))).toThrow(/üst dizin/);
  });
});

describe.runIf(posix)("approver: readSecureFile", () => {
  const mk = (name: string, body = "{}", mode = 0o600) => { const p = join(root, name); writeFileSync(p, body, { mode }); chmodSync(p, mode); return p; };
  it("düzenli 0600 dosyayı okur", () => { expect(readSecureFile(mk("ok"), 100).toString()).toBe("{}"); });
  it("sembolik bağı reddeder (O_NOFOLLOW)", () => { symlinkSync(mk("t"), join(root, "l")); expect(() => readSecureFile(join(root, "l"), 100)).toThrow(); });
  it("hardlink'i (nlink>1) reddeder", () => { const p = mk("h"); linkSync(p, join(root, "h2")); expect(() => readSecureFile(p, 100)).toThrow(/nlink|bağ/); });
  it("FIFO'yu bloklamadan reddeder", () => { const p = join(root, "fifo"); execFileSync("mkfifo", [p]); chmodSync(p, 0o600); expect(() => readSecureFile(p, 100)).toThrow(/düzenli/); });
  it("yanlış modu ve boyut aşımını reddeder", () => {
    expect(() => readSecureFile(mk("m", "{}", 0o644), 100)).toThrow(/0600/);
    expect(() => readSecureFile(mk("big", "x".repeat(101)), 100)).toThrow(/boyut/);
    expect(readSecureFile(mk("edge", "x".repeat(100)), 100).length).toBe(100);
  });
  it("olmayan dosya fırlatır", () => { expect(() => readSecureFile(join(root, "yok"), 10)).toThrow(); });
});

describe.runIf(posix)("approver: writeAtomic", () => {
  it("0600 yazar, artık temp dosya bırakmaz", () => {
    const p = join(root, "w.json");
    writeAtomic(p, "a");
    expect(readFileSync(p, "utf8")).toBe("a");
    expect(lstatSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["w.json"]);
  });
  it("varsayılan üzerine yazmaz; overwrite:true yazar", () => {
    const p = join(root, "w.json");
    writeAtomic(p, "a");
    expect(() => writeAtomic(p, "b")).toThrow(/EEXIST|mevcut/);
    expect(readFileSync(p, "utf8")).toBe("a");
    expect(readdirSync(root)).toEqual(["w.json"]);
    writeAtomic(p, "b", { overwrite: true });
    expect(readFileSync(p, "utf8")).toBe("b");
  });
  it("wx yarışı: iki yazıcıdan tam biri kazanır", () => {
    const p = join(root, "race");
    const r = ["a", "b"].map((v) => { try { writeAtomic(p, v); return true; } catch { return false; } });
    expect(r.filter(Boolean)).toHaveLength(1);
  });
});

describe("F-vlad-351: assertSecretParentSecure üst dizin sahibi", () => {
  it("üst dizin geçerli kullanıcıya ya da root'a aitse geçer; başka kullanıcıya aitse reddedilir", () => {
    if (process.platform === "win32") return;
    const d = realpathSync(mkdtempSync(join(tmpdir(), "vlad-psec-")));
    try {
      chmodSync(d, 0o755);
      expect(() => assertSecretParentSecure(join(d, "gizli"))).not.toThrow(); // sahibi biz
      expect(() => assertSecretParentSecure("/gizli")).not.toThrow(); // "/" root'a ait
      const spy = vi.spyOn(process, "getuid").mockReturnValue((process.getuid!() + 1) as never); // dizin artık "başkasının"
      try { expect(() => assertSecretParentSecure(join(d, "gizli"))).toThrow(/sahib/); } finally { spy.mockRestore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("approver: NAME_RE", () => {
  it("26 karakter base32 (a-z2-7); traversal ve büyük harf reddedilir", () => {
    const ok = "abcdefghijklmnopqrstuvwxyz".slice(0, 26);
    expect(NAME_RE.id.test(ok)).toBe(true);
    expect(NAME_RE.cid.test("a".repeat(26))).toBe(true);
    for (const bad of ["", "a".repeat(25), "a".repeat(27), "../".repeat(9) + "ab", "A".repeat(26), "1".repeat(26), "a".repeat(25) + "\n"]) expect(NAME_RE.id.test(bad), bad).toBe(false);
  });
});
