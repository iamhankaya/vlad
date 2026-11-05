import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { canSymlink } from "../helpers.js";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { XFER_CHUNK_BYTES, XFER_MAX_ACTIVE } from "../../src/transfer/types.js";
import { makeRig, newId, sha, type Rig } from "./a1-recv-helpers.js";

const rigs: Rig[] = [];
const rig = (o?: Parameters<typeof makeRig>[0]) => { const r = makeRig(o); rigs.push(r); return r; };
afterEach(() => { while (rigs.length) rigs.pop()!.cleanup(); });
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => `${(e as { code: string }).code}|${(e as Error).message}`);
const hello = Buffer.from("merhaba dünya");

describe("A1.3 begin: doğrulama", () => {
  it("geçersiz id", async () => {
    const r = rig();
    for (const id of ["", "../x", "A".repeat(32), 5 as unknown as string]) expect(await code(r.begin(id, [{ path: "a", kind: "file", size: 1 }]))).toBe("bad_request|bad_request: aktarım kimliği geçersiz");
    expect(r.staging()).toEqual([]);
  });
  const E = (path: string, size = 1, kind: "file" | "dir" = "file") => ({ path, kind, size });
  const table: [string, unknown, RegExp][] = [
    ["boş manifest", [], /^bad_request: manifest geçersiz: /],
    ["dizi değil", "x", /^bad_request: manifest geçersiz: /],
    ["bilinmeyen tür", [{ path: "a", kind: "link", size: 1 }], /^bad_request: manifest geçersiz: /],
    ["negatif boyut", [E("a", -1)], /^bad_request: manifest geçersiz: /],
    ["kesirli boyut", [E("a", 1.5)], /^bad_request: manifest geçersiz: /],
    ["dir boyutu 0 değil", [E("a", 3, "dir")], /^bad_request: manifest geçersiz: /],
    ["yol geçersiz", [E("../a")], /^bad_request: yol geçersiz: /],
    ["aynı yol iki kez (harf duyarsız)", [E("a.txt"), E("A.TXT")], /^bad_request: manifest geçersiz: /],
    ["a ile a/b", [E("a"), E("a/b")], /^bad_request: manifest geçersiz: /],
    ["a/b ile a (ters sıra)", [E("a/b"), E("a")], /^bad_request: manifest geçersiz: /],
    ["üst düzey harf çakışması", [E("D/x"), E("d/y")], /^bad_request: manifest geçersiz: /],
    ["dizin bileşen harf çakışması", [E("d/X/a"), E("d/x/b")], /^bad_request: manifest geçersiz: /],
  ];
  for (const [name, entries, re] of table) it(`reddeder: ${name}`, async () => {
    const r = rig();
    const res = await code(r.call("xfer-begin", { id: newId(), purpose: "file", entries }));
    expect(res.startsWith("bad_request|")).toBe(true);
    expect(res.split("|")[1]).toMatch(re);
    expect(r.staging()).toEqual([]);
  });
  it("amaç, meta ve öğe sayısı", async () => {
    const r = rig();
    expect(await code(r.call("xfer-begin", { id: newId(), purpose: "x", entries: [E("a")] }))).toMatch(/^bad_request\|bad_request: manifest geçersiz/);
    expect(await code(r.call("xfer-begin", { id: newId(), purpose: "file", entries: [E("a")], meta: { x: {} } }))).toMatch(/^bad_request\|bad_request: manifest geçersiz/);
    const many = Array.from({ length: 10_001 }, (_, i) => E(`f${i}`, 0));
    expect(await code(r.call("xfer-begin", { id: newId(), purpose: "file", entries: many }))).toMatch(/^bad_request\|bad_request: manifest geçersiz/);
  });
  it("4 GiB sınırı aşılırsa too_large", async () => {
    const r = rig();
    expect(await code(r.begin(newId(), [E("a", 4 * 1024 ** 3 + 1)]))).toBe("too_large|too_large: aktarım 4 GiB sınırını aşıyor");
  });
  it("Windows alıcıda CON reddedilir, darwin'de kabul", async () => {
    const w = rig({ os: "win32" });
    expect(await code(w.begin(newId(), [E("CON.txt")]))).toMatch(/^bad_request\|bad_request: yol geçersiz/);
    const m = rig({ os: "darwin" });
    expect(await code(m.begin(newId(), [E("CON.txt")]))).toBe("ok");
  });
});

describe("A1.3 begin: durum, idempotans, kaynak sınırları", () => {
  it("yeni aktarım: hazırlık klasörü 0700 ve meta.json; sonuç new + chunkBytes", async () => {
    const r = rig(); const id = newId();
    const res = await r.begin(id, [{ path: "a.txt", kind: "file", size: 5 }]);
    expect(res).toMatchObject({ id, chunkBytes: XFER_CHUNK_BYTES, state: "new" });
    const st = join(r.downloads, ".vlad-incoming", id);
    if (process.platform !== "win32") { // Windows'ta POSIX mod bitleri yok
      expect(statSync(st).mode & 0o777).toBe(0o700);
      expect(statSync(join(r.downloads, ".vlad-incoming")).mode & 0o777).toBe(0o700);
    }
    expect(JSON.parse(readFileSync(join(st, "meta.json"), "utf8"))).toMatchObject({ from: "mac", id });
    expect(readdirSync(r.downloads).filter((n) => n !== ".vlad-incoming")).toEqual([]); // teslimden önce görünür iz yok
  });
  it("aynı manifest ikinci begin: receiving + received; ilerleme sıfırlanmaz", async () => {
    const r = rig(); const id = newId(); const e = [{ path: "a.txt", kind: "file" as const, size: 10 }];
    await r.begin(id, e); await r.chunk(id, 0, 0, Buffer.from("abcd"));
    expect(await r.begin(id, e)).toMatchObject({ state: "receiving", received: [4] });
  });
  it("aynı id farklı manifest → conflict; başka makine aynı id → conflict", async () => {
    const r = rig(); const id = newId();
    await r.begin(id, [{ path: "a", kind: "file", size: 1 }]);
    expect(await code(r.begin(id, [{ path: "b", kind: "file", size: 1 }]))).toBe("conflict|conflict: aktarım kimliği başka bir istekle kullanılmış");
    expect(await code(r.begin(id, [{ path: "a", kind: "file", size: 1 }], {}, "windows"))).toBe("conflict|conflict: aktarım kimliği başka bir istekle kullanılmış");
  });
  it("etkin aktarım sınırı: busy", async () => {
    const r = rig();
    for (let i = 0; i < XFER_MAX_ACTIVE; i++) await r.begin(newId(), [{ path: `f${i}`, kind: "file", size: 1 }]);
    expect(await code(r.begin(newId(), [{ path: "x", kind: "file", size: 1 }]))).toBe("busy|busy: çok fazla etkin aktarım");
  });
  it("boş alan yetersiz → too_large; rezervasyon eşzamanlı begin'lerde toplanır", async () => {
    const GiB = 1024 ** 3;
    const r = rig({ deps: { fs: { statfs: async () => ({ bavail: 5 * GiB, bsize: 1 }) } } });
    const mk = (id: string) => r.begin(id, [{ path: "big", kind: "file", size: 2 * GiB }]);
    const res = await Promise.all([mk(newId()), mk(newId()), mk(newId())].map(code));
    expect(res.filter((x) => x === "ok")).toHaveLength(2); // 5 GiB - 2*2 GiB = 1 GiB kalır; üçüncüsü 1 GiB tamponu bozar
    expect(res.filter((x) => x === "too_large|too_large: boş alan yetersiz")).toHaveLength(1);
  });
  it("hazırlık kotası dolu → too_large", async () => {
    const GiB = 1024 ** 3;
    const r = rig({ deps: { fs: { statfs: async () => ({ bavail: 1000 * GiB, bsize: 1 }) } } });
    await r.begin(newId(), [{ path: "a", kind: "file", size: 4 * GiB }]);
    await r.begin(newId(), [{ path: "b", kind: "file", size: 4 * GiB }]);
    expect(await code(r.begin(newId(), [{ path: "c", kind: "file", size: 1 }]))).toBe("too_large|too_large: hazırlık kotası dolu");
  });
  it("clip-image: sink yoksa/kapalıysa failed; geçerli manifest tek clip.png", async () => {
    const off = rig();
    const e = [{ path: "clip.png", kind: "file" as const, size: 10 }];
    expect(await code(off.begin(newId(), e, { purpose: "clip-image", meta: { eventTs: 1, rank: 0 } }))).toBe("failed|failed: pano kapalı veya desteklenmiyor");
    const disabled = rig({ clipImage: { enabled: () => false, apply: async () => "applied" } });
    expect(await code(disabled.begin(newId(), e, { purpose: "clip-image", meta: { eventTs: 1, rank: 0 } }))).toBe("failed|failed: pano kapalı veya desteklenmiyor");
    const on = rig({ clipImage: { enabled: () => true, apply: async () => "applied" } });
    for (const bad of [{ entries: [{ path: "x.png", kind: "file" as const, size: 10 }], meta: { eventTs: 1, rank: 0 } }, { entries: e, meta: { eventTs: 1 } }, { entries: e, meta: { eventTs: 1, rank: 2 } }, { entries: [{ path: "clip.png", kind: "file" as const, size: 21 * 1024 * 1024 }], meta: { eventTs: 1, rank: 0 } }, { entries: e, meta: undefined }])
      expect((await code(on.call("xfer-begin", { id: newId(), purpose: "clip-image", ...bad }))).startsWith("bad_request|")).toBe(true);
    expect(await code(on.begin(newId(), e, { purpose: "clip-image", meta: { eventTs: 1, rank: 1 } }))).toBe("ok");
  });
});

describe("A1.4 chunk", () => {
  const setup = async (size = 10) => { const r = rig(); const id = newId(); await r.begin(id, [{ path: "a.bin", kind: "file", size }]); return { r, id }; };
  it("sırayla yazar; received döner; yinelenen aynı parça idempotent", async () => {
    const { r, id } = await setup();
    expect(await r.chunk(id, 0, 0, Buffer.from("abcd"))).toEqual({ received: 4 });
    expect(await r.chunk(id, 0, 0, Buffer.from("abcd"))).toEqual({ received: 4 });
    expect(await r.chunk(id, 0, 4, Buffer.from("efghij"))).toEqual({ received: 10 });
    expect(await r.chunk(id, 0, 2, Buffer.from("cd"))).toEqual({ received: 10 }); // örtüşen eski aralık, aynı bayt
  });
  it("aynı aralık farklı bayt → conflict; ileri atlama → conflict (alınan n)", async () => {
    const { r, id } = await setup();
    await r.chunk(id, 0, 0, Buffer.from("abcd"));
    expect(await code(r.chunk(id, 0, 0, Buffer.from("XXXX")))).toMatch(/^conflict\|conflict: parça/);
    expect(await code(r.chunk(id, 0, 6, Buffer.from("z")))).toBe("conflict|conflict: parça sırası bozuk (alınan 4)");
    expect(await code(r.chunk(id, 0, 2, Buffer.from("cdXX")))).toMatch(/^conflict\|/); // kısmi örtüşme
  });
  it("beyan boyutunu aşan parça → bad_request boyut uyuşmuyor", async () => {
    const { r, id } = await setup(4);
    expect(await code(r.chunk(id, 0, 0, Buffer.from("abcde")))).toBe("bad_request|bad_request: boyut uyuşmuyor");
  });
  it("geçersiz argümanlar", async () => {
    const { r, id } = await setup();
    for (const a of [{ id, entry: 1, offset: 0, data: "" }, { id, entry: -1, offset: 0, data: "" }, { id, entry: 0, offset: -1, data: "" }, { id, entry: 0, offset: 1.5, data: "" }, { id, entry: 0, offset: 0, data: "!!!" }, { id, entry: 0, offset: 0, data: 5 }, { id, entry: "0", offset: 0, data: "" }])
      expect((await code(r.call("xfer-chunk", a))).startsWith("bad_request|")).toBe(true);
  });
  it("chunkBytes'tan büyük parça reddedilir", async () => {
    const r = rig(); const id = newId(); await r.begin(id, [{ path: "big", kind: "file", size: XFER_CHUNK_BYTES + 10 }]);
    expect((await code(r.chunk(id, 0, 0, Buffer.alloc(XFER_CHUNK_BYTES + 1)))).startsWith("bad_request|")).toBe(true);
    await r.chunk(id, 0, 0, Buffer.alloc(XFER_CHUNK_BYTES));
  });
  it("dizin girdisine parça → bad_request; bilinmeyen aktarım → not_found; başka makine → not_found", async () => {
    const r = rig(); const id = newId();
    await r.begin(id, [{ path: "d", kind: "dir", size: 0 }, { path: "f", kind: "file", size: 1 }]);
    expect((await code(r.chunk(id, 0, 0, Buffer.from("x")))).startsWith("bad_request|")).toBe(true);
    expect(await code(r.chunk(newId(), 0, 0, Buffer.from("x")))).toBe("not_found|not_found: aktarım bulunamadı");
    expect(await code(r.chunk(id, 1, 0, Buffer.from("x"), "windows"))).toBe("not_found|not_found: aktarım bulunamadı");
  });
  it("eşzamanlı aynı chunk'lar mutex ile sıralanır, bayt bozulmaz", async () => {
    const { r, id } = await setup();
    const res = await Promise.all([0, 1, 2, 3, 4].map(() => r.chunk(id, 0, 0, Buffer.from("abcde"))));
    expect(res.every((x) => x.received === 5)).toBe(true);
  });
  it("ENOSPC/EPERM hata eşlemesi", async () => {
    const GiB = 1024 ** 3;
    for (const [errno, want] of [["ENOSPC", /^too_large\|too_large: boş alan yetersiz/], ["EPERM", /^failed\|failed: İndirilenler erişimi reddedildi/]] as const) {
      const r = rig({ deps: { fs: { statfs: async () => ({ bavail: 100 * GiB, bsize: 1 }) }, hooks: { afterChunk: async () => { throw Object.assign(new Error("x"), { code: errno }); } } } });
      const id = newId(); await r.begin(id, [{ path: "a", kind: "file", size: 4 }]);
      expect(await code(r.chunk(id, 0, 0, Buffer.from("abcd")))).toMatch(want);
    }
  });
});

describe("A1.5 commit: teslim", () => {
  it("tek dosya: bayt bayt eşit, İndirilenler'de, hazırlık temiz, bildirim bir kez", async () => {
    const r = rig(); const id = newId();
    const res = await r.put(id, "a.txt", hello);
    expect(res.items).toEqual([{ name: "a.txt", kind: "file", size: hello.length, path: join(r.downloads, "a.txt") }]);
    expect(readFileSync(join(r.downloads, "a.txt"))).toEqual(hello);
    expect(r.staging()).toEqual([]);
    expect(r.notifier.calls).toHaveLength(1);
    expect(r.notifier.calls[0]!.title).toBe("mac'den dosya geldi");
    expect(r.notifier.calls[0]!.body).toContain("a.txt");
  });
  it("boş dosya ve büyük (çok parçalı) dosya", async () => {
    const r = rig();
    await r.put(newId(), "empty", Buffer.alloc(0));
    expect(readFileSync(join(r.downloads, "empty")).length).toBe(0);
    const big = Buffer.alloc(XFER_CHUNK_BYTES * 2 + 123, 7);
    const id = newId();
    await r.begin(id, [{ path: "big", kind: "file", size: big.length }]);
    for (let o = 0; o < big.length; o += XFER_CHUNK_BYTES) await r.chunk(id, 0, o, big.subarray(o, o + XFER_CHUNK_BYTES));
    await r.commit(id, [sha(big)]);
    expect(readFileSync(join(r.downloads, "big")).equals(big)).toBe(true);
  });
  it("çok öğeli: dizin + dosya + boş dizin; tek bildirim; öğeler üst düzey adla", async () => {
    const r = rig(); const id = newId();
    const a = Buffer.from("A"), b = Buffer.from("BB"), c = Buffer.from("CCC");
    await r.begin(id, [{ path: "proj/a.txt", kind: "file", size: 1 }, { path: "proj/sub/b.txt", kind: "file", size: 2 }, { path: "proj/empty", kind: "dir", size: 0 }, { path: "solo.txt", kind: "file", size: 3 }, { path: "bos", kind: "dir", size: 0 }]);
    await r.chunk(id, 0, 0, a); await r.chunk(id, 1, 0, b); await r.chunk(id, 3, 0, c);
    const res = await r.commit(id, [sha(a), sha(b), null, sha(c), null]);
    expect(res.items.map((i) => [i.name, i.kind, i.size])).toEqual([["proj", "dir", 3], ["solo.txt", "file", 3], ["bos", "dir", 0]]);
    expect(readFileSync(join(r.downloads, "proj", "sub", "b.txt"), "utf8")).toBe("BB");
    expect(lstatSync(join(r.downloads, "proj", "empty")).isDirectory()).toBe(true);
    expect(lstatSync(join(r.downloads, "bos")).isDirectory()).toBe(true);
    expect(r.notifier.calls).toHaveLength(1);
    expect(r.staging()).toEqual([]);
  });
  it("ad çakışması: ad (1), harf duyarsız; mevcut dosya ezilmez", async () => {
    const r = rig();
    writeFileSync(join(r.downloads, "A.txt"), "eski");
    const res = await r.put(newId(), "a.txt", hello);
    expect(res.items[0]!.name).toBe("a (1).txt");
    expect(readFileSync(join(r.downloads, "A.txt"), "utf8")).toBe("eski");
    const res2 = await r.put(newId(), "a.txt", hello);
    expect(res2.items[0]!.name).toBe("a (2).txt");
  });
  it("dizin çakışması: boş mevcut dizin bile ezilmez (d → d (1))", async () => {
    const r = rig(); mkdirSync(join(r.downloads, "d"));
    const id = newId();
    await r.begin(id, [{ path: "d/x", kind: "file", size: 1 }]); await r.chunk(id, 0, 0, Buffer.from("x"));
    const res = await r.commit(id, [sha("x")]);
    expect(res.items[0]!.name).toBe("d (1)");
    expect(readdirSync(join(r.downloads, "d"))).toEqual([]);
    expect(readFileSync(join(r.downloads, "d (1)", "x"), "utf8")).toBe("x");
  });
  it.skipIf(!canSymlink())("hedef ad önceden (kırık) symlink ise ezilmez", async () => {
    const r = rig(); symlinkSync("/nonexistent/hedef", join(r.downloads, "a.txt"));
    const res = await r.put(newId(), "a.txt", hello);
    expect(res.items[0]!.name).toBe("a (1).txt");
    expect(lstatSync(join(r.downloads, "a.txt")).isSymbolicLink()).toBe(true);
  });
  it("yayımlama sırasında hedef doğan yarış: EEXIST → sonraki ad", async () => {
    const r = rig({ deps: { hooks: { beforePublish: async () => { writeFileSync(join(r.downloads, "a.txt"), "yarış"); } } } });
    const res = await r.put(newId(), "a.txt", hello);
    expect(res.items[0]!.name).toBe("a (1).txt");
    expect(readFileSync(join(r.downloads, "a.txt"), "utf8")).toBe("yarış");
  });
  it("link EXDEV/EPERM → copyFile yedeği", async () => {
    for (const errno of ["EXDEV", "EPERM", "ENOTSUP"]) {
      let copied = 0;
      const { copyFile } = await import("node:fs/promises");
      const r = rig({ deps: { fs: { link: async () => { throw Object.assign(new Error("x"), { code: errno }); }, copyFile: async (a, b, m) => { copied++; return copyFile(a, b, m); } } } });
      const res = await r.put(newId(), "a.txt", hello);
      expect(copied).toBe(1);
      expect(readFileSync(res.items[0]!.path)).toEqual(hello);
      expect(r.staging()).toEqual([]);
    }
  });
  it("sha256 uyuşmazlığı ve eksik bayt → bad_request, hiçbir iz kalmaz", async () => {
    const r = rig();
    const id = newId(); await r.begin(id, [{ path: "a", kind: "file", size: 4 }]); await r.chunk(id, 0, 0, Buffer.from("abcd"));
    expect(await code(r.commit(id, [sha("xxxx")]))).toBe("bad_request|bad_request: boyut uyuşmuyor");
    expect(r.staging()).toEqual([]);
    expect(readdirSync(r.downloads)).toEqual([".vlad-incoming"]);
    const id2 = newId(); await r.begin(id2, [{ path: "a", kind: "file", size: 4 }]); await r.chunk(id2, 0, 0, Buffer.from("ab"));
    expect(await code(r.commit(id2, [sha("abcd")]))).toBe("bad_request|bad_request: boyut uyuşmuyor");
    expect(r.staging()).toEqual([]);
    expect(await code(r.chunk(id2, 0, 2, Buffer.from("cd")))).toMatch(/^not_found/);
  });
  it("commit argümanları: sha256 dizisi uzunluğu ve biçimi", async () => {
    const r = rig(); const id = newId(); await r.begin(id, [{ path: "a", kind: "file", size: 0 }]);
    for (const s of [[], ["x"], [null], [sha("") , sha("")]]) expect((await code(r.call("xfer-commit", { id, sha256: s }))).startsWith("bad_request|")).toBe(true);
  });
  it("commit tekrarı (yanıt kaybı): aynı sonuç, ikinci kopya ve ikinci bildirim yok", async () => {
    const r = rig(); const id = newId();
    const first = await r.put(id, "a.txt", hello);
    const again = await r.commit(id, [sha(hello)]);
    expect(again.items).toEqual(first.items);
    expect(readdirSync(r.downloads).sort()).toEqual([".vlad-incoming", "a.txt"]);
    expect(r.notifier.calls).toHaveLength(1);
    // begin tekrarı da biter: committed + items
    expect(await r.begin(id, [{ path: "a.txt", kind: "file", size: hello.length }])).toMatchObject({ state: "committed", items: first.items });
  });
  it("eşzamanlı iki commit: tek teslim", async () => {
    const r = rig(); const id = newId();
    await r.begin(id, [{ path: "a.txt", kind: "file", size: hello.length }]); await r.chunk(id, 0, 0, hello);
    const [x, y] = await Promise.all([r.commit(id, [sha(hello)]), r.commit(id, [sha(hello)])]);
    expect(x.items).toEqual(y.items);
    expect(readdirSync(r.downloads).sort()).toEqual([".vlad-incoming", "a.txt"]);
  });
  it("bildirim hatası teslimi bozmaz; çoklu öğe gövdesi sayıyı içerir", async () => {
    const r = rig(); r.notifier.failNext();
    const res = await r.put(newId(), "a.txt", hello);
    expect(res.items).toHaveLength(1);
    const r2 = rig(); const id = newId();
    await r2.begin(id, [{ path: "x", kind: "file", size: 0 }, { path: "y", kind: "file", size: 0 }]);
    await r2.commit(id, [sha(""), sha("")]);
    expect(r2.notifier.calls).toHaveLength(1);
    expect(r2.notifier.calls[0]!.body).toMatch(/x/);
    expect(r2.notifier.calls[0]!.body).toMatch(/1/);
  });
  it("kısmi başarı: 2. öğe başarısız → items + failed, 1. öğe kalır, hazırlık temiz, tek bildirim", async () => {
    let n = 0;
    const r = rig({ deps: { hooks: { beforePublish: async () => { if (++n === 2) throw Object.assign(new Error("x"), { code: "ENOSPC" }); } } } });
    const id = newId();
    await r.begin(id, [{ path: "one", kind: "file", size: 0 }, { path: "two", kind: "file", size: 0 }]);
    const res = await r.commit(id, [sha(""), sha("")]);
    expect(res.items.map((i) => i.name)).toEqual(["one"]);
    expect(res.failed).toMatchObject({ name: "two" });
    expect(res.failed!.error).toMatch(/boş alan yetersiz/);
    expect(existsSync(join(r.downloads, "one"))).toBe(true);
    expect(existsSync(join(r.downloads, "two"))).toBe(false);
    expect(r.staging()).toEqual([]);
    expect(r.notifier.calls).toHaveLength(1);
    // tekrar commit: teslim sonucu belirsiz (kayıt committed değil)
    expect(await code(r.commit(id, [sha(""), sha("")]))).toBe("uncertain|uncertain: teslim sonucu belirsiz; İndirilenler'e bak");
  });
  it("ilk öğe başarısızsa istek hata ile biter; iz kalmaz", async () => {
    const r = rig({ deps: { hooks: { beforePublish: async () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } } } });
    const id = newId(); await r.begin(id, [{ path: "one", kind: "file", size: 0 }]);
    expect(await code(r.commit(id, [sha("")]))).toMatch(/^failed\|failed: İndirilenler erişimi reddedildi/);
    expect(r.staging()).toEqual([]);
    expect(readdirSync(r.downloads)).toEqual([".vlad-incoming"]);
  });
  it("Windows: dizin rezervasyonsuz rename; hedef varsa sonraki ad", async () => {
    const r = rig({ os: "win32" }); mkdirSync(join(r.downloads, "d"));
    const id = newId(); await r.begin(id, [{ path: "d/x", kind: "file", size: 1 }]); await r.chunk(id, 0, 0, Buffer.from("x"));
    expect((await r.commit(id, [sha("x")])).items[0]!.name).toBe("d (1)");
  });
});

describe("A1.5 commit: clip-image", () => {
  const png = (w = 2, h = 2) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write("IHDR", 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  const clipRig = (result: "applied" | "stale" | "disabled" | "invalid" = "applied") => {
    const calls: { png: Buffer; meta: unknown; from: string }[] = [];
    const r = rig({ clipImage: { enabled: () => true, apply: async (p, meta, from) => { calls.push({ png: p, meta, from }); return result; } } });
    return { r, calls };
  };
  const send = async (r: Rig, data: Buffer, id = newId()) => {
    await r.begin(id, [{ path: "clip.png", kind: "file", size: data.length }], { purpose: "clip-image", meta: { eventTs: 5, rank: 1 } });
    await r.chunk(id, 0, 0, data);
    return { id, res: r.commit(id, [sha(data)]) };
  };
  it("sink çağrılır; İndirilenler'de iz ve bildirim yok; items boş; clip sonucu döner", async () => {
    const { r, calls } = clipRig("stale"); const p = png();
    const { res } = await send(r, p);
    expect(await res).toEqual({ items: [], clip: "stale" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ meta: { eventTs: 5, rank: 1 }, from: "mac" });
    expect(calls[0]!.png.equals(p)).toBe(true);
    expect(readdirSync(r.downloads)).toEqual([".vlad-incoming"]);
    expect(r.staging()).toEqual([]);
    expect(r.notifier.calls).toEqual([]);
  });
  it("commit tekrarı sink'i ikinci kez çağırmaz (çift uygulama engeli)", async () => {
    const { r, calls } = clipRig(); const p = png();
    const { id, res } = await send(r, p); await res;
    expect((await r.commit(id, [sha(p)])).items).toEqual([]);
    expect(calls).toHaveLength(1);
  });
  it("PNG değil / dev boyut → bad_request, sink çağrılmaz, temizlik", async () => {
    for (const data of [Buffer.from("png değil ".repeat(5)), png(10_000, 10_000), png(0, 5)]) {
      const { r, calls } = clipRig();
      const { res } = await send(r, data);
      expect((await code(res)).startsWith("bad_request|")).toBe(true);
      expect(calls).toHaveLength(0);
      expect(r.staging()).toEqual([]);
    }
  });
});

describe("A1.6 abort / sweep / idle", () => {
  it("abort: hazırlık silinir, sonraki chunk not_found; yoksa idempotent", async () => {
    const r = rig(); const id = newId();
    await r.begin(id, [{ path: "a", kind: "file", size: 5 }]); await r.chunk(id, 0, 0, Buffer.from("ab"));
    await r.call("xfer-abort", { id });
    expect(r.staging()).toEqual([]);
    expect(await code(r.chunk(id, 0, 2, Buffer.from("c")))).toMatch(/^not_found/);
    await r.call("xfer-abort", { id }); await r.call("xfer-abort", { id: newId() });
    expect((await code(r.call("xfer-abort", { id: "../x" }))).startsWith("bad_request|")).toBe(true);
  });
  it("abort rezervasyonu serbest bırakır", async () => {
    const GiB = 1024 ** 3;
    const r = rig({ deps: { fs: { statfs: async () => ({ bavail: 3 * GiB, bsize: 1 }) } } });
    const a = newId(); await r.begin(a, [{ path: "a", kind: "file", size: 2 * GiB }]);
    expect(await code(r.begin(newId(), [{ path: "b", kind: "file", size: 2 * GiB }]))).toMatch(/^too_large/);
    await r.call("xfer-abort", { id: a });
    expect(await code(r.begin(newId(), [{ path: "b", kind: "file", size: 2 * GiB }]))).toBe("ok");
  });
  it("abort başka makineyi etkilemez", async () => {
    const r = rig(); const id = newId(); await r.begin(id, [{ path: "a", kind: "file", size: 1 }]);
    await r.call("xfer-abort", { id }, "windows");
    expect(r.staging()).toEqual([id]);
  });
  it("etkinlik zaman aşımı (enjekte saat): sweep süresi dolan receiving'i abort eder", async () => {
    const r = rig(); const id = newId(); await r.begin(id, [{ path: "a", kind: "file", size: 1 }]);
    r.clock.t += 4 * 60_000; expect(await r.rx.sweep()).toBe(0); expect(r.staging()).toEqual([id]);
    await r.chunk(id, 0, 0, Buffer.from("x")); // etkinlik zamanlayıcıyı yeniler
    r.clock.t += 4 * 60_000; expect(await r.rx.sweep()).toBe(0);
    r.clock.t += 2 * 60_000; expect(await r.rx.sweep()).toBe(1);
    expect(r.staging()).toEqual([]);
    expect(await code(r.chunk(id, 0, 0, Buffer.from("x")))).toMatch(/^not_found/);
  });
  it("zaman aşımı kapasiteyi serbest bırakır: begin önce süresi dolanları temizler", async () => {
    const r = rig();
    for (let i = 0; i < XFER_MAX_ACTIVE; i++) await r.begin(newId(), [{ path: `f${i}`, kind: "file", size: 1 }]);
    r.clock.t += 6 * 60_000;
    expect(await code(r.begin(newId(), [{ path: "yeni", kind: "file", size: 1 }]))).toBe("ok");
  });
  it("sweep yalnız meta.json sahipli, 24 saatten eski, etkin olmayan .vlad-incoming/<id> siler; kullanıcı dosyalarına dokunmaz", async () => {
    const r = rig(); const inc = join(r.downloads, ".vlad-incoming");
    const id = newId(); await r.begin(id, [{ path: "a", kind: "file", size: 1 }]); // etkin
    mkdirSync(join(inc, "0".repeat(32)), { recursive: true }); writeFileSync(join(inc, "0".repeat(32), "x"), "sahipsiz"); // meta yok
    const orphan = "1".repeat(32); mkdirSync(join(inc, orphan)); writeFileSync(join(inc, orphan, "meta.json"), JSON.stringify({ from: "mac", id: orphan, manifestHash: "h", state: "receiving", createdAt: r.clock.t - 25 * 3600_000 }));
    const young = "2".repeat(32); mkdirSync(join(inc, young)); writeFileSync(join(inc, young, "meta.json"), JSON.stringify({ from: "mac", id: young, manifestHash: "h", state: "receiving", createdAt: r.clock.t - 3600_000 }));
    mkdirSync(join(inc, "kullanici-klasoru")); writeFileSync(join(inc, "kullanici-klasoru", "meta.json"), "{}");
    writeFileSync(join(r.downloads, "benim.txt"), "kullanıcı");
    expect(await r.rx.sweep()).toBe(1);
    expect(r.staging().sort()).toEqual([id, "0".repeat(32), young, "kullanici-klasoru"].sort());
    expect(readFileSync(join(r.downloads, "benim.txt"), "utf8")).toBe("kullanıcı");
  });
  it.skipIf(!canSymlink())("sweep sembolik bağı izlemez", async () => {
    const r = rig(); const inc = join(r.downloads, ".vlad-incoming"); mkdirSync(inc);
    const victim = join(r.base, "victim"); mkdirSync(victim); writeFileSync(join(victim, "meta.json"), JSON.stringify({ from: "x", id: "3".repeat(32), manifestHash: "h", state: "receiving", createdAt: 0 })); writeFileSync(join(victim, "dokunma"), "x");
    symlinkSync(victim, join(inc, "3".repeat(32)));
    await r.rx.sweep();
    expect(existsSync(join(victim, "dokunma"))).toBe(true);
  });
  it("yarış: abort ∥ chunk ∥ commit tutarlı sonuçlanır (teslim ya tam ya hiç)", async () => {
    for (let i = 0; i < 20; i++) {
      const r = rig(); const id = newId();
      await r.begin(id, [{ path: "a.txt", kind: "file", size: hello.length }]); await r.chunk(id, 0, 0, hello);
      const [c, a] = await Promise.all([code(r.commit(id, [sha(hello)])), code(r.call("xfer-abort", { id }))]);
      expect(a).toBe("ok");
      const has = existsSync(join(r.downloads, "a.txt"));
      if (c === "ok") expect(readFileSync(join(r.downloads, "a.txt"))).toEqual(hello); else expect(has).toBe(false);
      expect(r.staging()).toEqual([]);
      r.cleanup();
    }
  });
});

describe("A1.2/A1.5 çökme: yeniden başlama", () => {
  it("receiving iken yeniden başlama: aynı id ile begin dosyaları sıfırlayıp yeniden başlar", async () => {
    const r = rig(); const id = newId(); const e = [{ path: "a.txt", kind: "file" as const, size: 4 }];
    await r.begin(id, e); await r.chunk(id, 0, 0, Buffer.from("ab"));
    await r.restart();
    expect(await code(r.chunk(id, 0, 2, Buffer.from("cd")))).toMatch(/^not_found/);
    expect(await r.begin(id, e)).toMatchObject({ state: "new" });
    await r.chunk(id, 0, 0, Buffer.from("abcd"));
    expect((await r.commit(id, [sha("abcd")])).items).toHaveLength(1);
  });
  it("yeniden başlamadan sonra farklı manifest → conflict", async () => {
    const r = rig(); const id = newId();
    await r.begin(id, [{ path: "a", kind: "file", size: 1 }]); await r.restart();
    expect(await code(r.begin(id, [{ path: "b", kind: "file", size: 1 }]))).toMatch(/^conflict\|/);
  });
  it("committed sonrası yeniden başlama: begin committed + items döner, yeniden yükleme yok", async () => {
    const r = rig(); const id = newId();
    const first = await r.put(id, "a.txt", hello); await r.restart();
    expect(await r.begin(id, [{ path: "a.txt", kind: "file", size: hello.length }])).toMatchObject({ state: "committed", items: first.items });
    expect((await r.commit(id, [sha(hello)])).items).toEqual(first.items);
  });
  it("committing kaydı (çökme): begin ve commit uncertain verir; kopya oluşmaz", async () => {
    const { createLedger } = await import("../../src/transfer/ledger.js");
    const r = rig(); const id = newId();
    await r.begin(id, [{ path: "a.txt", kind: "file", size: 1 }]); await r.chunk(id, 0, 0, Buffer.from("x"));
    await createLedger(r.stateDir).put(`mac\0${id}`, { state: "committing", planned: ["a.txt"], published: [] });
    await r.restart();
    const msg = "uncertain|uncertain: teslim sonucu belirsiz; İndirilenler'e bak";
    expect(await code(r.begin(id, [{ path: "a.txt", kind: "file", size: 1 }]))).toBe(msg);
    expect(await code(r.commit(id, [sha("x")]))).toBe(msg);
    expect(readdirSync(r.downloads)).toEqual([".vlad-incoming"]);
  });
  it("commit sırasında çökme: committing yazılmış, öğe yayımlanmış → tekrar commit uncertain (çift teslim yok)", async () => {
    // çökmeyi, yayımlama kancasında süreç yerine bellek kaybıyla (restart) modelle: ikinci öğeden önce durdur
    let r!: Rig; let armed = true; let n = 0;
    r = rig({ deps: { hooks: { beforePublish: async () => { if (armed && ++n === 2) { armed = false; await r.restart(); throw new Error("süreç öldü"); } } } } });
    const id = newId();
    await r.begin(id, [{ path: "one", kind: "file", size: 0 }, { path: "two", kind: "file", size: 0 }]);
    await code(r.commit(id, [sha(""), sha("")]));
    const again = await code(r.commit(id, [sha(""), sha("")]));
    expect(again).toBe("uncertain|uncertain: teslim sonucu belirsiz; İndirilenler'e bak");
    expect(readdirSync(r.downloads).filter((x) => x !== ".vlad-incoming")).toEqual(["one"]);
  });
});

describe("A1 inceleme düzeltmeleri", () => {
  it("begin hata yolu yabancı hazırlık klasörünü silmez (meta yok / başka sahip)", async () => {
    const r = rig(); const inc = join(r.downloads, ".vlad-incoming"); mkdirSync(inc);
    const a = newId(); mkdirSync(join(inc, a)); writeFileSync(join(inc, a, "x"), "başkasının");
    expect((await code(r.begin(a, [{ path: "f", kind: "file", size: 1 }]))).startsWith("failed|")).toBe(true);
    expect(readFileSync(join(inc, a, "x"), "utf8")).toBe("başkasının");
    const b = newId(); mkdirSync(join(inc, b)); writeFileSync(join(inc, b, "x"), "y");
    writeFileSync(join(inc, b, "meta.json"), JSON.stringify({ from: "windows", id: b, manifestHash: "h", state: "receiving", createdAt: r.clock.t }));
    expect((await code(r.begin(b, [{ path: "f", kind: "file", size: 1 }]))).startsWith("conflict|")).toBe(true);
    expect(existsSync(join(inc, b, "x"))).toBe(true);
  });
  it("sweep∥begin: eski yetimi silmeye çalışan sweep, araya giren aynı id'li begin'in klasörünü silmez", async () => {
    const r = rig(); const inc = join(r.downloads, ".vlad-incoming"); mkdirSync(inc);
    const id = newId(); const e = [{ path: "f", kind: "file" as const, size: 1 }];
    await r.begin(id, e); await r.rx.close();
    // yetim: aynı manifestHash'li eski meta ile yeniden başlama senaryosu
    const meta = JSON.parse(readFileSync(join(inc, id, "meta.json"), "utf8"));
    writeFileSync(join(inc, id, "meta.json"), JSON.stringify({ ...meta, createdAt: r.clock.t - 25 * 3600_000 }));
    await r.restart();
    const [, res] = await Promise.all([r.rx.sweep(), r.begin(id, e)]);
    expect(res.state).toBe("new");
    await r.chunk(id, 0, 0, Buffer.from("x")); // klasör sağ
    expect((await r.commit(id, [sha("x")])).items).toHaveLength(1);
  });
  it("clip-image: apply çağrılırken teslim kaydı committing (apply∥çökme sonrası yeniden begin uncertain)", async () => {
    let during: string | undefined; let r!: Rig;
    r = rig({ clipImage: { enabled: () => true, apply: async () => { const { createLedger } = await import("../../src/transfer/ledger.js"); during = (await createLedger(r.stateDir).get(`mac\0${id}`))?.state; return "applied"; } } });
    const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(2, 16); png.writeUInt32BE(2, 20);
    var id = newId(); const e = [{ path: "clip.png", kind: "file" as const, size: png.length }];
    await r.begin(id, e, { purpose: "clip-image", meta: { eventTs: 1, rank: 0 } }); await r.chunk(id, 0, 0, png);
    await r.commit(id, [sha(png)]);
    expect(during).toBe("committing");
    expect(await r.begin(id, e, { purpose: "clip-image", meta: { eventTs: 1, rank: 0 } })).toMatchObject({ state: "committed" });
  });
});
