import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { adsPath, createOriginMarker, quarantineCommand, quarantineValue, zoneIdentifier } from "../../src/platform/origin.js";
import { NativeDisabledError } from "../../src/platform/native.js";
import { makeRig, newId, sha, type Rig } from "./a1-recv-helpers.js";

const rigs: Rig[] = [];
const rig = (o?: Parameters<typeof makeRig>[0]) => { const r = makeRig(o); rigs.push(r); return r; };
afterEach(() => { while (rigs.length) rigs.pop()!.cleanup(); vi.restoreAllMocks(); });

describe("F-vlad-204 köken işareti: saf üreticiler", () => {
  it("macOS: com.apple.quarantine değeri ve argv (kabuk yok)", () => {
    expect(quarantineValue(0x6543_0000_0 / 16 * 1000)).toMatch(/^0081;[0-9a-f]+;vlad;$/);
    const c = quarantineCommand("/Users/u/Downloads/a b'; rm -rf ~.txt", 1_800_000_000_000);
    expect(c.file).toBe("xattr");
    expect(c.args).toEqual(["-w", "com.apple.quarantine", `0081;${Math.floor(1_800_000_000).toString(16)};vlad;`, "/Users/u/Downloads/a b'; rm -rf ~.txt"]);
  });
  it("Windows: Zone.Identifier ADS yolu ve içeriği (ZoneId=3, vlad:// ana bilgisayar)", () => {
    expect(adsPath("C:\\Users\\u\\Downloads\\a.txt")).toBe("C:\\Users\\u\\Downloads\\a.txt:Zone.Identifier");
    expect(zoneIdentifier("mac")).toBe("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=vlad://mac\r\n");
    expect(zoneIdentifier("ma\r\nc]x")).not.toMatch(/\r\n.*\r\n.*\r\n.*\r\n/); // enjeksiyon: ek satır yok
    expect(zoneIdentifier("ma\r\nZoneId=0")).toBe("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=vlad://maZoneId0\r\n");
  });
  it("createOriginMarker: darwin xattr çalıştırır, win32 ADS yazar; native kapalıyken NativeDisabledError", async () => {
    const ran: unknown[] = [], wrote: [string, string][] = [];
    await createOriginMarker("darwin", { exec: async (c) => { ran.push(c); }, write: async () => {}, now: () => 1_800_000_000_000 })("/x/a", "mac");
    expect(ran).toHaveLength(1);
    await createOriginMarker("win32", { exec: async () => {}, write: async (p, c) => { wrote.push([p, c]); } })("C:\\d\\a.txt", "mac");
    expect(wrote).toEqual([["C:\\d\\a.txt:Zone.Identifier", zoneIdentifier("mac")]]);
    await expect(createOriginMarker("darwin")("/x/a", "mac")).rejects.toBeInstanceOf(NativeDisabledError);
  });
});

describe("F-vlad-204 alıcı: yayımlanan her dosyaya işaret", () => {
  const body = Buffer.from("x");
  it("tek dosya ve dizin içi dosyalar işaretlenir; işaret yayımlamadan önce (hazırlıktaki dosyada) yazılır", async () => {
    const seen: { rel: string; from: string; visible: boolean }[] = [];
    let r!: Rig;
    r = rig({ deps: { markOrigin: async (p, from) => { seen.push({ rel: p.split("/").pop()!, from, visible: existsSync(join(r.downloads, p.split("/").pop()!)) }); } } });
    const id = newId();
    await r.begin(id, [{ path: "solo.txt", kind: "file", size: 1 }, { path: "d/a.txt", kind: "file", size: 1 }, { path: "d/s/b.txt", kind: "file", size: 1 }, { path: "d/empty", kind: "dir", size: 0 }]);
    for (const i of [0, 1, 2]) await r.chunk(id, i, 0, body);
    await r.commit(id, [sha(body), sha(body), sha(body), null]);
    expect(seen.map((s) => s.rel).sort()).toEqual(["a.txt", "b.txt", "solo.txt"]);
    expect(seen.every((s) => s.from === "mac")).toBe(true);
    expect(seen.every((s) => !s.visible)).toBe(true); // işaretlenirken İndirilenler'de henüz görünmez
  });
  it("işaret yazılamazsa teslim bozulmaz, stderr'e uyarı", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = rig({ deps: { markOrigin: async () => { throw new Error("xattr yok"); } } });
    const res = await r.put(newId(), "a.txt", body);
    expect(res.items).toHaveLength(1);
    expect(readFileSync(join(r.downloads, "a.txt"))).toEqual(body);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("köken işareti"))).toBe(true);
  });
  it("copyFile yedeğinde de işaret son dosyada bulunur (kopya sonrası yeniden işaretlenir)", async () => {
    const seen: string[] = [];
    const r = rig({ deps: { fs: { link: async () => { throw Object.assign(new Error("x"), { code: "EPERM" }); } }, markOrigin: async (p) => { seen.push(p); } } });
    await r.put(newId(), "a.txt", body);
    expect(seen.length).toBeGreaterThanOrEqual(2); // hazırlık dosyası + kopya
    expect(seen.some((p) => p.includes("pub-"))).toBe(true);
  });
  it("clip-image dosya yayımlamaz: işaret yok", async () => {
    const seen: string[] = [];
    const r = rig({ clipImage: { enabled: () => true, apply: async () => "applied" }, deps: { markOrigin: async (p) => { seen.push(p); } } });
    const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(2, 16); png.writeUInt32BE(2, 20);
    const id = newId(); await r.begin(id, [{ path: "clip.png", kind: "file", size: 33 }], { purpose: "clip-image", meta: { eventTs: 1, rank: 0 } });
    await r.chunk(id, 0, 0, png); await r.commit(id, [sha(png)]);
    expect(seen).toEqual([]);
  });
});

describe("F-vlad-210 copyFile yedeği: yarım dosya görünmez", () => {
  const eperm = () => Object.assign(new Error("x"), { code: "EPERM" });
  it("kopya sırasında nihai ad İndirilenler'de yok; kopya hazırlıkta özel geçici hedefe yapılır", async () => {
    const { copyFile } = await import("node:fs/promises");
    const during: { dest: string; listing: string[] }[] = [];
    let r!: Rig;
    r = rig({ deps: { fs: { link: async () => { throw eperm(); }, copyFile: async (a, b, m) => { await copyFile(a, b, m); during.push({ dest: String(b), listing: readdirSync(r.downloads) }); } } } });
    const res = await r.put(newId(), "a.txt", Buffer.from("tam"));
    expect(during).toHaveLength(1);
    expect(during[0]!.dest).toContain(".vlad-incoming");
    expect(during[0]!.listing).toEqual([".vlad-incoming"]);
    expect(readFileSync(res.items[0]!.path, "utf8")).toBe("tam");
    expect(r.staging()).toEqual([]);
  });
  it("kopya yarıda çökerse (hata) İndirilenler'de iz kalmaz", async () => {
    const { writeFile } = await import("node:fs/promises");
    const r = rig({ deps: { fs: { link: async () => { throw eperm(); }, copyFile: async (_a, b) => { await writeFile(b, "yar"); throw Object.assign(new Error("x"), { code: "EIO" }); } } } });
    const id = newId(); await r.begin(id, [{ path: "a.txt", kind: "file", size: 4 }]); await r.chunk(id, 0, 0, Buffer.from("tamm"));
    await expect(r.commit(id, [sha("tamm")])).rejects.toMatchObject({ code: "failed" });
    expect(readdirSync(r.downloads)).toEqual([".vlad-incoming"]);
    expect(r.staging()).toEqual([]);
  });
  it("kopya yayımlanırken hedef doğarsa üzerine yazılmaz: sonraki ad", async () => {
    const { writeFileSync } = await import("node:fs");
    const { copyFile } = await import("node:fs/promises");
    let r!: Rig;
    r = rig({ deps: { fs: { link: async () => { throw eperm(); }, copyFile: async (a, b, m) => { await copyFile(a, b, m); writeFileSync(join(r.downloads, "a.txt"), "yarış"); } } } });
    const res = await r.put(newId(), "a.txt", Buffer.from("tam"));
    expect(res.items[0]!.name).toBe("a (1).txt");
    expect(readFileSync(join(r.downloads, "a.txt"), "utf8")).toBe("yarış");
    expect(readFileSync(join(r.downloads, "a (1).txt"), "utf8")).toBe("tam");
  });
});
