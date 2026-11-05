// aktarim-kabul K1 — dosya gönderme: tasarımın hedefleri ve anti-hedefleri (docs/superpowers/specs/2026-11-05-vlad-aktarim-design.md).
// Yalnız harness API'si, op imzaları (plan "Arayüzler"), dosya sistemi gözlemi ve CLI çıkış kodu. Uygulama bitene dek kırmızı:
// stub'lar NotImplementedOp / "henüz gerçeklenmedi" ile düşer.
import { createServer } from "node:net";
import { existsSync, lstatSync, mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteError } from "../../src/fleet/types.js";
import { sendPaths } from "../../src/transfer/send.js";
import { XFER_CHUNK_BYTES, XFER_MAX_ENTRIES, XFER_MAX_TOTAL_BYTES, XFER_STAGING_DIR } from "../../src/transfer/types.js";
import { makeFile, startAktarimPair, treeHash, type AktarimPair } from "../aktarim/harness.js";
import { canSymlink, rmTemp } from "../helpers.js";
import { makeHomePair, spawnVlad } from "../machines/harness.js";
import { b64, bytes, codeOf, entriesOf, hashesOf, listAll, messageOf, mkTemp, newId, rawUpload, read, sha256, visible, wire, type RawItem } from "./aktarim-helpers.js";

const pairs: AktarimPair[] = [];
const temps: string[] = [];
afterEach(async () => { for (const p of pairs.splice(0)) await p.stop(); for (const t of temps.splice(0)) rmTemp(t); });
const pair = async (...a: Parameters<typeof startAktarimPair>) => { const p = await startAktarimPair(...a); pairs.push(p); return p; };
const tmp = () => { const d = mkTemp(); temps.push(d); return d; };
const f = (path: string, n: number, seed = 1): RawItem => ({ path, data: bytes(n, seed) });

describe("aktarim-kabul: iki yönde dosya", () => {
  it("mac → windows: içerik birebir, İndirilenler'e düşer, tek bildirim 'mac'ten dosya geldi'", async () => {
    const p = await pair();
    const data = bytes(1234, 3);
    const { commit } = await rawUpload(p.mac.transport, "windows", [{ path: "rapor.bin", data }]);
    expect(visible(p.windows.downloads)).toEqual(["rapor.bin"]);
    expect(sha256(read(p.windows.downloads, "rapor.bin"))).toBe(sha256(data));
    expect(commit!.items).toEqual([expect.objectContaining({ name: "rapor.bin", kind: "file", size: 1234 })]);
    expect(p.windows.notifier.calls).toHaveLength(1);
    expect(p.windows.notifier.calls[0]!.title).toMatch(/mac/i);
    expect(p.windows.notifier.calls[0]!.body).toContain("rapor.bin");
    expect(p.mac.notifier.calls).toEqual([]); // gönderen tarafta bildirim yok
  });
  it("windows → mac: aynı sözleşme (işçi → beyin yönü)", async () => {
    const p = await pair();
    const data = bytes(777, 9);
    await rawUpload(p.windows.transport, "mac", [{ path: "shot.png", data }]);
    expect(sha256(read(p.mac.downloads, "shot.png"))).toBe(sha256(data));
    expect(p.mac.notifier.calls).toHaveLength(1);
    expect(p.mac.notifier.calls[0]!.title).toMatch(/windows/i);
  });
  it("sendPaths: dosya + klasör (iç içe, boş dizin) iki yönde yapı ve içerik korunur", async () => {
    const p = await pair();
    const src = tmp();
    makeFile(src, "proje/a.txt", 100, 1); makeFile(src, "proje/alt/b.bin", XFER_CHUNK_BYTES + 1, 2); mkdirSync(join(src, "proje", "bos"), { recursive: true });
    const single = makeFile(src, "tek.dat", 5, 3);
    const r = await sendPaths(p.mac.transport, { to: "windows", paths: [join(src, "proje"), single] });
    expect(r.items.map((i) => i.name).sort()).toEqual(["proje", "tek.dat"]);
    expect(r.totalBytes).toBe(100 + XFER_CHUNK_BYTES + 1 + 5);
    expect(treeHash(join(p.windows.downloads, "proje"))).toBe(treeHash(join(src, "proje")));
    expect(existsSync(join(p.windows.downloads, "proje", "bos"))).toBe(true);
    expect(visible(p.windows.downloads)).toEqual(["proje", "tek.dat"]);
    // ters yön
    const r2 = await sendPaths(p.windows.transport, { to: "mac", paths: [join(src, "proje")] });
    expect(r2.to).toBe("mac");
    expect(treeHash(join(p.mac.downloads, "proje"))).toBe(treeHash(join(src, "proje")));
  });
  it.each([0, 1, XFER_CHUNK_BYTES - 1, XFER_CHUNK_BYTES, XFER_CHUNK_BYTES + 1, 2 * XFER_CHUNK_BYTES])("parça sınırı: %i bayt dosya bozulmadan ulaşır", async (n) => {
    const p = await pair();
    const src = tmp();
    const file = makeFile(src, "x.bin", n, 5);
    await sendPaths(p.mac.transport, { to: "windows", paths: [file] });
    expect(sha256(read(p.windows.downloads, "x.bin"))).toBe(sha256(read(file)));
  }, 60_000);
  it.skipIf(!canSymlink())("sembolik bağ gönderilmez (izlenmez): skipped'a düşer, hedefte iz yok", async () => {
    const p = await pair();
    const src = tmp(), outside = tmp();
    writeFileSync(join(outside, "gizli.txt"), "gizli");
    makeFile(src, "d/a.txt", 10, 1);
    symlinkSync(join(outside, "gizli.txt"), join(src, "d", "link.txt"));
    const r = await sendPaths(p.mac.transport, { to: "windows", paths: [join(src, "d")] });
    expect(r.skipped).toEqual([expect.objectContaining({ reason: "symlink" })]);
    expect(listAll(p.windows.downloads, [XFER_STAGING_DIR])).toEqual(["d", "d/a.txt"]);
  });
  it("olmayan yol: hiçbir şey gönderilmez, hata fırlar", async () => {
    const p = await pair();
    const before = listAll(p.windows.downloads);
    await expect(sendPaths(p.mac.transport, { to: "windows", paths: [join(tmp(), "yok.txt")] })).rejects.toBeInstanceOf(Error);
    expect(listAll(p.windows.downloads)).toEqual(before);
    expect(p.windows.notifier.calls).toEqual([]);
  });
});

describe("aktarim-kabul: üzerine yazma yok, çakışmada 'ad (1).ext'", () => {
  it("var olan dosya dokunulmaz; yenisi 'a (1).txt', sonraki 'a (2).txt'", async () => {
    const p = await pair();
    writeFileSync(join(p.windows.downloads, "a.txt"), "ESKİ");
    await rawUpload(p.mac.transport, "windows", [{ path: "a.txt", data: Buffer.from("YENİ-1") }]);
    await rawUpload(p.mac.transport, "windows", [{ path: "a.txt", data: Buffer.from("YENİ-2") }]);
    expect(read(p.windows.downloads, "a.txt").toString()).toBe("ESKİ");
    expect(read(p.windows.downloads, "a (1).txt").toString()).toBe("YENİ-1");
    expect(read(p.windows.downloads, "a (2).txt").toString()).toBe("YENİ-2");
  });
  it("klasör adı çakışması: var olan dizin (boş bile olsa) ezilmez → 'd (1)'", async () => {
    const p = await pair();
    mkdirSync(join(p.windows.downloads, "d"));
    mkdirSync(join(p.windows.downloads, "dolu"));
    writeFileSync(join(p.windows.downloads, "dolu", "eski.txt"), "ESKİ");
    await rawUpload(p.mac.transport, "windows", [f("d/x.txt", 3), f("dolu/y.txt", 4)]);
    expect(existsSync(join(p.windows.downloads, "d", "x.txt"))).toBe(false); // boş dizine bile birleşme yok
    expect(existsSync(join(p.windows.downloads, "d (1)", "x.txt"))).toBe(true);
    expect(existsSync(join(p.windows.downloads, "dolu (1)", "y.txt"))).toBe(true);
    expect(read(p.windows.downloads, "dolu", "eski.txt").toString()).toBe("ESKİ");
  });
  it("harf duyarsız çakışma (APFS/NTFS): 'A.txt' varken gelen 'a.txt' → 'a (1).txt'", async () => {
    const p = await pair();
    writeFileSync(join(p.windows.downloads, "A.txt"), "ESKİ");
    await rawUpload(p.mac.transport, "windows", [{ path: "a.txt", data: Buffer.from("YENİ") }]);
    expect(read(p.windows.downloads, "A.txt").toString()).toBe("ESKİ");
    expect(visible(p.windows.downloads).map((n) => n.toLowerCase()).sort()).toEqual(["a (1).txt", "a.txt"]);
  });
  it.skipIf(!canSymlink())("hedef ad sembolik bağsa (kırık dahil) bağın gösterdiği dosya ezilmez", async () => {
    const p = await pair();
    const outside = tmp();
    writeFileSync(join(outside, "hedef.txt"), "DIŞARIDA");
    symlinkSync(join(outside, "hedef.txt"), join(p.windows.downloads, "s.txt"));
    symlinkSync(join(outside, "yok-kirik.txt"), join(p.windows.downloads, "k.txt"));
    await rawUpload(p.mac.transport, "windows", [f("s.txt", 7), f("k.txt", 7)]);
    expect(read(outside, "hedef.txt").toString()).toBe("DIŞARIDA");
    expect(existsSync(join(outside, "yok-kirik.txt"))).toBe(false);
    expect(lstatSync(join(p.windows.downloads, "s.txt")).isSymbolicLink()).toBe(true);
    expect(visible(p.windows.downloads)).toEqual(["k (1).txt", "k.txt", "s (1).txt", "s.txt"]);
  });
  it("kontrol–yayımlama yarışı: yayımlama anında aynı ad dışarıdan yaratılırsa o dosya ezilmez", async () => {
    let race: string | undefined;
    const p = await pair({ windows: { hooks: { beforePublish: async (item) => { if (race) writeFileSync(join(race, item), "ARAYA-GİREN"); } } } });
    race = p.windows.downloads;
    await rawUpload(p.mac.transport, "windows", [{ path: "r.txt", data: Buffer.from("GELEN") }]);
    expect(read(p.windows.downloads, "r.txt").toString()).toBe("ARAYA-GİREN");
    expect(read(p.windows.downloads, "r (1).txt").toString()).toBe("GELEN");
  });
});

describe("aktarim-kabul: yarım aktarım İndirilenler'de görünmez", () => {
  it("commit'siz bırakılan aktarım: görünür küme değişmez", async () => {
    const p = await pair();
    writeFileSync(join(p.windows.downloads, "onceden.txt"), "x");
    const before = visible(p.windows.downloads);
    await rawUpload(p.mac.transport, "windows", [f("buyuk.bin", XFER_CHUNK_BYTES + 10)], { commit: false });
    expect(visible(p.windows.downloads)).toEqual(before);
  });
  it("hash uyuşmazlığı: commit reddedilir, iz kalmaz, bildirim yok", async () => {
    const p = await pair();
    const items = [f("bozuk.bin", 500)];
    const code = await codeOf(rawUpload(p.mac.transport, "windows", items, { sha: [sha256("başka")] }));
    expect(code).toBe("bad_request");
    expect(visible(p.windows.downloads)).toEqual([]);
    expect(p.windows.notifier.calls).toEqual([]);
  });
  it("eksik bayt (beyan edilen boyuttan az gelen): commit reddedilir, iz kalmaz", async () => {
    const p = await pair();
    const it = f("eksik.bin", 1000);
    const id = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: entriesOf([it]) });
    await wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64((it as { data: Buffer }).data.subarray(0, 600)) });
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-commit", { id, sha256: hashesOf([it]) }))).toBe("bad_request");
    expect(visible(p.windows.downloads)).toEqual([]);
  });
  it("xfer-abort: hazırlık temizlenir, görünür küme değişmez, ardından commit bulunamaz", async () => {
    const p = await pair();
    const { id } = await rawUpload(p.mac.transport, "windows", [f("a.bin", 100)], { commit: false });
    await wire(p.mac.transport, "windows", "xfer-abort", { id });
    expect(visible(p.windows.downloads)).toEqual([]);
    expect(["not_found", "conflict"]).toContain(await codeOf(wire(p.mac.transport, "windows", "xfer-commit", { id, sha256: [sha256(bytes(100, 1))] })));
    expect(visible(p.windows.downloads)).toEqual([]);
  });
  it("alıcı Agent yarıda yeniden başlar: yarım dosya görünmez; aynı id ile baştan yüklenince tam bir kez teslim edilir", async () => {
    const p = await pair();
    const items = [f("x.bin", XFER_CHUNK_BYTES + 100, 4)];
    const { id } = await rawUpload(p.mac.transport, "windows", items, { commit: false, stopAfterChunks: 1 });
    expect(visible(p.windows.downloads)).toEqual([]);
    await p.restartAgent("windows");
    expect(visible(p.windows.downloads)).toEqual([]);
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: XFER_CHUNK_BYTES, data: b64((items[0] as { data: Buffer }).data.subarray(XFER_CHUNK_BYTES)) }))).toBe("not_found");
    await rawUpload(p.mac.transport, "windows", items, { id });
    expect(visible(p.windows.downloads)).toEqual(["x.bin"]);
    expect(sha256(read(p.windows.downloads, "x.bin"))).toBe(sha256((items[0] as { data: Buffer }).data));
    expect(p.windows.notifier.calls).toHaveLength(1);
  });
  it("commit yanıtı kayıp (proxy düşürür): aynı commit tekrarında çift teslim yok", async () => {
    const p = await pair();
    const px = await p.viaProxy("mac");
    const items = [f("tek.bin", 64, 6)];
    const id = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: entriesOf(items) });
    await wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64((items[0] as { data: Buffer }).data) });
    px.dropResponse(1);
    const first = await codeOf(wire(p.mac.transport, "windows", "xfer-commit", { id, sha256: hashesOf(items) }, { timeoutMs: 5000 }));
    expect(["timeout", "unreachable"]).toContain(first);
    const again = await wire<{ items: unknown[] }>(p.mac.transport, "windows", "xfer-commit", { id, sha256: hashesOf(items) });
    expect(again.items).toHaveLength(1);
    expect(visible(p.windows.downloads)).toEqual(["tek.bin"]); // "tek (1).bin" yok
    expect(p.windows.notifier.calls).toHaveLength(1);
  });
  it("teslimden sonra Agent yeniden başlasa da aynı id ile tekrar gelen aktarım çift teslim üretmez", async () => {
    const p = await pair();
    const items = [f("z.bin", 50, 8)];
    const id = newId();
    await rawUpload(p.mac.transport, "windows", items, { id });
    await p.restartAgent("windows");
    const again = await wire<{ state: string; items?: unknown[] }>(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: entriesOf(items) });
    expect(again.state).toBe("committed");
    expect(again.items).toHaveLength(1);
    expect(visible(p.windows.downloads)).toEqual(["z.bin"]);
  });
  it("çoklu öğe: öğe düzeyinde teslim — 2. öğe yayımlanamazsa 1. kalır, hata satırı raporlanır, 2. İndirilenler'de yok", async () => {
    const p = await pair({ windows: { hooks: { beforePublish: async (item) => { if (item === "b.txt") throw new Error("disk hatası (test)"); } } } });
    const { commit } = await rawUpload(p.mac.transport, "windows", [f("a.txt", 5, 1), f("b.txt", 5, 2)]);
    expect(commit!.items.map((i) => i.name)).toEqual(["a.txt"]);
    expect(commit!.failed).toMatchObject({ name: "b.txt" });
    expect(visible(p.windows.downloads)).toEqual(["a.txt"]);
  });
});

describe("aktarim-kabul: yol kaçışı reddedilir", () => {
  // Kesin red: üst dizin, mutlak yol, sürücü harfi, UNC, hazırlık klasörü adı, boş/NUL bileşen
  const mustReject = ["../x", "a/../../x", "a/..", "../../etc/passwd", "/etc/passwd", "/abs.txt", "C:\\x", "C:/x", "\\\\srv\\share\\x", ".vlad-incoming", ".vlad-incoming/x", "a//b", "", "a/\u0000b", "\u0000"];
  // Ters bölü karışıklığı: ya reddedilir ya da güvenli biçimde İndirilenler içinde kalır
  const mixedSeparators = ["a\\..\\..\\x", "..\\x", "a/b\\..\\..\\..\\x"];
  const windowsOnly = ["CON", "nul.txt", "COM1.tar.gz", "dir/PRN", "a.", "a ", "a<b", "a:b", "a|b", "a?b", 'a"b', "a*b"];

  const outsideUntouched = (p: AktarimPair, before: string[]) => expect(listAll(dirname(p.windows.downloads), ["state"]).filter((x) => !x.startsWith("Downloads"))).toEqual(before);
  const outsideSnapshot = (p: AktarimPair) => listAll(dirname(p.windows.downloads), ["state"]).filter((x) => !x.startsWith("Downloads"));

  it.each(mustReject)("%j → bad_request, hiçbir yerde iz yok", async (path) => {
    const p = await pair();
    const before = outsideSnapshot(p);
    const code = await codeOf(rawUpload(p.mac.transport, "windows", [{ path, data: Buffer.from("zararlı") }]));
    expect(code).toBe("bad_request");
    expect(visible(p.windows.downloads)).toEqual([]);
    outsideUntouched(p, before);
  });
  it.each(mixedSeparators)("karışık ayraç %j → reddedilir ya da İndirilenler içinde kalır; dışarı yazılmaz", async (path) => {
    const p = await pair();
    const before = outsideSnapshot(p);
    const code = await codeOf(rawUpload(p.mac.transport, "windows", [{ path, data: Buffer.from("zararlı") }]));
    expect(["bad_request", "ok"]).toContain(code);
    outsideUntouched(p, before);
    expect(existsSync(join(dirname(p.windows.downloads), "x"))).toBe(false);
  });
  it.each(windowsOnly)("Windows alıcıda geçersiz ad %j → bad_request", async (path) => {
    const p = await pair();
    expect(await codeOf(rawUpload(p.mac.transport, "windows", [{ path, data: Buffer.from("x") }]))).toBe("bad_request");
    expect(visible(p.windows.downloads)).toEqual([]);
  });
  it.each(["../../x", ".", "", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0", "../0123456789abcdef0123456789abcdef"])("aktarım kimliği %j geçersiz → bad_request (hazırlık yolu kaçamaz)", async (id) => {
    const p = await pair();
    const before = outsideSnapshot(p);
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: [{ path: "a", kind: "file", size: 1 }] }))).toBe("bad_request");
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64("a") }))).toBe("bad_request");
    outsideUntouched(p, before);
  });
  it.skipIf(!canSymlink())("sembolik bağ olan üst ada yazılmaz: İndirilenler içindeki 'ln → dışarı' izlenmez; gelen 'ln (1)' olarak içeride teslim edilir", async () => {
    const p = await pair();
    const outside = tmp();
    symlinkSync(outside, join(p.windows.downloads, "ln"));
    await rawUpload(p.mac.transport, "windows", [f("ln/x.txt", 5)]);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
    expect(lstatSync(join(p.windows.downloads, "ln")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(p.windows.downloads, "ln (1)", "x.txt"))).toBe(true);
  });
  it("aynı yol iki kez, 'a' ile 'a/b' birlikte, harf duyarsız tekrar → manifest reddedilir", async () => {
    const p = await pair();
    for (const entries of [
      [{ path: "a", kind: "file", size: 1 }, { path: "a", kind: "file", size: 1 }],
      [{ path: "a", kind: "file", size: 1 }, { path: "a/b", kind: "file", size: 1 }],
      [{ path: "A.txt", kind: "file", size: 1 }, { path: "a.txt", kind: "file", size: 1 }],
    ]) {
      expect(await codeOf(wire(p.mac.transport, "windows", "xfer-begin", { id: newId(), purpose: "file", entries }))).toBe("bad_request");
    }
    expect(visible(p.windows.downloads)).toEqual([]);
  });
  it("manifest sayıları: negatif/kesirli/NaN size ve chunk offset reddedilir", async () => {
    const p = await pair();
    for (const size of [-1, 1.5, Number.NaN, "10" as unknown as number]) {
      expect(await codeOf(wire(p.mac.transport, "windows", "xfer-begin", { id: newId(), purpose: "file", entries: [{ path: "a", kind: "file", size }] })), String(size)).toBe("bad_request");
    }
    const id = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: [{ path: "a", kind: "file", size: 4 }] });
    for (const offset of [-1, 0.5, Number.NaN]) {
      expect(await codeOf(wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset, data: b64("abcd") })), String(offset)).toBe("bad_request");
    }
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 5, offset: 0, data: b64("abcd") }))).toBe("bad_request");
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64("abcdef") }))).toBe("bad_request"); // beyan edilenden fazla
    expect(visible(p.windows.downloads)).toEqual([]);
  });
  it("dizin girdisine chunk yapılamaz", async () => {
    const p = await pair();
    const id = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: [{ path: "bos", kind: "dir", size: 0 }] });
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64("x") }))).toBe("bad_request");
  });
});

describe("aktarim-kabul: boyut sınırları", () => {
  it("toplam 4 GiB'ı aşan manifest begin'de reddedilir (veri göndermeden), iz yok", async () => {
    const p = await pair();
    const code = await codeOf(wire(p.mac.transport, "windows", "xfer-begin", { id: newId(), purpose: "file", entries: [{ path: "dev.bin", kind: "file", size: XFER_MAX_TOTAL_BYTES + 1 }] }));
    expect(code).toBe("too_large");
    expect(visible(p.windows.downloads)).toEqual([]);
  });
  it("birden çok girdinin toplamı 4 GiB'ı aşarsa da reddedilir", async () => {
    const p = await pair();
    const half = XFER_MAX_TOTAL_BYTES / 2 + 1;
    const code = await codeOf(wire(p.mac.transport, "windows", "xfer-begin", { id: newId(), purpose: "file", entries: [{ path: "a", kind: "file", size: half }, { path: "b", kind: "file", size: half }] }));
    expect(code).toBe("too_large");
  });
  it("girdi sayısı sınırı (10.000) aşılırsa manifest reddedilir", async () => {
    const p = await pair();
    const entries = Array.from({ length: XFER_MAX_ENTRIES + 1 }, (_, i) => ({ path: `d/f${i}`, kind: "file" as const, size: 0 }));
    expect(["bad_request", "too_large"]).toContain(await codeOf(wire(p.mac.transport, "windows", "xfer-begin", { id: newId(), purpose: "file", entries })));
    expect(visible(p.windows.downloads)).toEqual([]);
  });
  it("boş alan yetersizse (sahte statfs) begin too_large; sığan aktarım geçer", async () => {
    let free = 10 * 1024 ** 3;
    const p = await pair({ windows: { fs: { statfs: async () => ({ bavail: free, bsize: 1 }) } } });
    free = 1024 ** 3 + 100; // taban 1 GiB + 100 bayt
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-begin", { id: newId(), purpose: "file", entries: [{ path: "buyuk", kind: "file", size: 1000 }] }))).toBe("too_large");
    free = 10 * 1024 ** 3;
    expect(await codeOf(rawUpload(p.mac.transport, "windows", [f("kucuk", 10)]))).toBe("ok");
  });
  // seyrek dosya (truncate) APFS/ext4'te disk harcamaz; NTFS'te ayırabilir → Windows'ta atlanır (raporda belirtilir)
  it.skipIf(process.platform === "win32")("sendPaths gönderici tarafında da 4 GiB'ı aşan toplamı veri göndermeden reddeder", async () => {
    const p = await pair();
    const src = tmp();
    const file = makeFile(src, "x.bin", 10, 1);
    // gerçek 4 GiB dosya yaratmadan: seyrek dosya (sparse) — truncate boyutu bildirir, disk harcamaz
    truncateSync(file, XFER_MAX_TOTAL_BYTES + 1);
    const e = await sendPaths(p.mac.transport, { to: "windows", paths: [file] }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(RemoteError);
    expect((e as RemoteError).code).toBe("too_large");
    expect(visible(p.windows.downloads)).toEqual([]);
    expect(p.windows.notifier.calls).toEqual([]);
  });
});

describe("aktarim-kabul: yetki ve kimlik", () => {
  it("yanlış anahtarla imzalanmış istek → auth, iz yok", async () => {
    const p = await pair();
    const bad = new (await import("../../src/agent/client.js")).AgentClient({
      self: "mac", keys: { windows: "ab".repeat(32) }, config: () => ({ brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 1 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: p.windows.port } }] }) as never,
    });
    expect(await codeOf(wire(bad, "windows", "xfer-begin", { id: newId(), purpose: "file", entries: [{ path: "a", kind: "file", size: 1 }] }))).toBe("auth");
    expect(visible(p.windows.downloads)).toEqual([]);
  });
  it("işçi kendi Agent'ına (rol 'self') aktarım op'u çağıramaz → forbidden", async () => {
    const p = await pair();
    for (const op of ["xfer-begin", "xfer-chunk", "xfer-commit", "xfer-abort", "clip-push"] as const) {
      expect(await codeOf(wire(p.windows.transport, "windows", op, { id: newId() })), op).toBe("forbidden");
    }
  });
  it("beyin Agent'ı da işçiden başkasına açılmaz: mac'e 'self' çağrısı forbidden", async () => {
    const p = await pair();
    for (const op of ["xfer-begin", "clip-push"] as const) expect(await codeOf(wire(p.mac.transport, "mac", op, { id: newId() })), op).toBe("forbidden");
  });
  it("anti-hedef: ek yapılandırma/eşleştirme gerekmez — yalnız mevcut çift anahtarla her iki yön çalışır", async () => {
    const p = await pair();
    await rawUpload(p.mac.transport, "windows", [f("a", 1)]);
    await rawUpload(p.windows.transport, "mac", [f("b", 1)]);
    expect(visible(p.windows.downloads)).toEqual(["a"]);
    expect(visible(p.mac.downloads)).toEqual(["b"]);
  });
});

describe("aktarim-kabul: ulaşılamaz makinede çıkış 75", () => {
  const closedPort = async (): Promise<number> => new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => res(port)); }); });
  it("sendPaths: Agent kapalıyken geçici (transient) RemoteError, alıcıda iz yok", async () => {
    const p = await pair();
    const src = tmp();
    const file = makeFile(src, "x.bin", 10, 1);
    const px = await p.viaProxy("mac");
    px.down();
    const e = await sendPaths(p.mac.transport, { to: "windows", paths: [file], sleep: async () => {} }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(RemoteError);
    expect((e as RemoteError).transient).toBe(true);
    expect(visible(p.windows.downloads)).toEqual([]);
  });
  it("vlad send (dist/cli.js): karşı Agent kapalı → çıkış 75; --json ile stderr {error,details}", async () => {
    const port = await closedPort();
    const homes = makeHomePair({ config: { brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port } }] } });
    try {
      const src = tmp();
      const file = makeFile(src, "x.bin", 10, 1);
      const r = spawnVlad(homes.brain, ["send", file, "--to", "windows"], { env: { VLAD_NO_NATIVE: "1" } });
      expect(r.code, r.err).toBe(75);
      const j = spawnVlad(homes.brain, ["send", file, "--to", "windows", "--json"], { env: { VLAD_NO_NATIVE: "1" } });
      expect(j.code, j.err).toBe(75);
      const parsed = JSON.parse(j.err.trim().split("\n").pop()!);
      expect(parsed).toHaveProperty("error");
      expect(Array.isArray(parsed.details)).toBe(true);
      expect(j.out.trim()).toBe(""); // stdout --json hata yolunda boş
    } finally { homes.cleanup(); }
  }, 60_000);
  it("vlad send: olmayan yol, bilinmeyen --to ve kendine gönderme çıkış 1 (75 değil)", async () => {
    const port = await closedPort();
    const homes = makeHomePair({ config: { brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port } }] } });
    try {
      const src = tmp();
      const file = makeFile(src, "x.bin", 10, 1);
      const notStub = (r: { code: number | null; err: string }, what: string, mention: RegExp) => {
        expect(r.code, r.err).toBe(1);
        expect(r.err, "stub değil, anlamlı hata").not.toMatch(/henüz gerçeklenmedi/);
        expect(r.err, what).toMatch(mention);
      };
      notStub(spawnVlad(homes.brain, ["send", join(src, "yok.bin"), "--to", "windows"]), "olmayan yol", /yok\.bin/);
      notStub(spawnVlad(homes.brain, ["send", file, "--to", "olmayan"]), "bilinmeyen --to", /olmayan/);
      notStub(spawnVlad(homes.brain, ["send", file, "--to", "mac"]), "kendine gönderme", /mac/);
    } finally { homes.cleanup(); }
  }, 60_000);
});
