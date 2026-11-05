import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteError, type RemoteTransport } from "../../src/machines/types.js";
import { sendPaths, uploadBuffer } from "../../src/transfer/send.js";
import { XFER_STAGING_DIR } from "../../src/transfer/types.js";
import { rmTemp } from "../helpers.js";
import { makeFile, startAktarimPair, treeHash, type AktarimPair } from "./harness.js";

const pairs: AktarimPair[] = [];
const temps: string[] = [];
afterEach(async () => { for (const p of pairs.splice(0)) await p.stop(); for (const t of temps.splice(0)) rmTemp(t); });
const pair = async () => { const p = await startAktarimPair(); pairs.push(p); return p; };
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-a2-")); temps.push(d); return d; };
/** op sayacı olan saydam sarmalayıcı */
const spy = (t: RemoteTransport) => {
  const calls: { op: string; args: any }[] = [];
  const w: RemoteTransport = { call: (to, op, args, o) => { calls.push({ op, args }); return t.call(to, op, args, o); } };
  return { w, calls };
};
const names = (d: string) => require("node:fs").readdirSync(d).filter((n: string) => n !== XFER_STAGING_DIR).sort();

describe("aktarim:A2 sendPaths", () => {
  it("dosya, klasör ve karma: yapı ve içerik korunur; totalBytes doğru", async () => {
    const p = await pair(); const src = tmp();
    makeFile(src, "d/a.txt", 100, 1); makeFile(src, "d/alt/b.bin", 5000, 2); mkdirSync(join(src, "d", "bos"));
    const one = makeFile(src, "tek.dat", 7, 3);
    const r = await sendPaths(p.mac.transport, { to: "windows", paths: [join(src, "d"), one], chunkBytes: 1024 });
    expect(r.to).toBe("windows"); expect(r.totalBytes).toBe(5107); expect(r.skipped).toEqual([]);
    expect(r.items.map((i) => i.name).sort()).toEqual(["d", "tek.dat"]);
    expect(treeHash(join(p.windows.downloads, "d"))).toBe(treeHash(join(src, "d")));
    expect(existsSync(join(p.windows.downloads, "d", "bos"))).toBe(true);
  });
  it("0 bayt dosya ve boş klasör tek başına gider", async () => {
    const p = await pair(); const src = tmp();
    const z = makeFile(src, "z.txt", 0, 1); mkdirSync(join(src, "bosdir"));
    const r = await sendPaths(p.mac.transport, { to: "windows", paths: [z, join(src, "bosdir")] });
    expect(r.totalBytes).toBe(0);
    expect(names(p.windows.downloads)).toEqual(["bosdir", "z.txt"]);
  });
  it.each([3 * 1024 * 1024 - 1, 3 * 1024 * 1024, 3 * 1024 * 1024 + 1])("parça sınırı %i bayt: bozulmadan ve beklenen parça sayısıyla", async (n) => {
    const p = await pair(); const src = tmp();
    const f = makeFile(src, "x.bin", n, 4);
    const { w, calls } = spy(p.mac.transport);
    await sendPaths(w, { to: "windows", paths: [f] });
    expect(readFileSync(join(p.windows.downloads, "x.bin")).equals(readFileSync(f))).toBe(true);
    expect(calls.filter((c) => c.op === "xfer-chunk")).toHaveLength(Math.ceil(n / (3 * 1024 * 1024)));
  });
  it("10 MiB dosya", async () => {
    const p = await pair(); const src = tmp();
    const f = makeFile(src, "big.bin", 10 * 1024 * 1024, 5);
    await sendPaths(p.mac.transport, { to: "windows", paths: [f] });
    expect(readFileSync(join(p.windows.downloads, "big.bin")).equals(readFileSync(f))).toBe(true);
  }, 60_000);
  it("symlink skipped'a düşer, hedefte iz yok; özel dosya (fifo) da", async () => {
    const p = await pair(); const src = tmp(), out = tmp();
    writeFileSync(join(out, "gizli"), "g"); makeFile(src, "d/a.txt", 10, 1);
    symlinkSync(join(out, "gizli"), join(src, "d", "link"));
    if (process.platform !== "win32") execFileSync("mkfifo", [join(src, "d", "boru")]);
    const r = await sendPaths(p.mac.transport, { to: "windows", paths: [join(src, "d")] });
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(process.platform === "win32" ? ["symlink"] : ["special", "symlink"]);
    expect(names(join(p.windows.downloads, "d"))).toEqual(["a.txt"]);
  });
  it("üst düzey sembolik bağ tek başına verilirse gönderilecek bir şey kalmaz → hata", async () => {
    const p = await pair(); const src = tmp();
    makeFile(src, "a", 1, 1); symlinkSync(join(src, "a"), join(src, "l"));
    const { w, calls } = spy(p.mac.transport);
    await expect(sendPaths(w, { to: "windows", paths: [join(src, "l")] })).rejects.toThrow(/gönderilecek/);
    expect(calls).toEqual([]);
  });
  it("olmayan yol: ağa hiç çıkmadan hata", async () => {
    const p = await pair();
    const { w, calls } = spy(p.mac.transport);
    await expect(sendPaths(w, { to: "windows", paths: [join(tmp(), "yok.txt")] })).rejects.toThrow(/yok\.txt/);
    expect(calls).toEqual([]);
  });
  it("ilerleme: sentBytes artar ve toplamda biter", async () => {
    const p = await pair(); const src = tmp();
    const f = makeFile(src, "x.bin", 2500, 1);
    const seen: number[] = []; let total = 0;
    await sendPaths(p.mac.transport, { to: "windows", paths: [f], chunkBytes: 1000, onProgress: (e) => { seen.push(e.sentBytes); total = e.totalBytes; } });
    expect(seen).toEqual([1000, 2000, 2500]); expect(total).toBe(2500);
  });
  it("ping caps yok → 'karşı Agent güncel değil'; begin'e geçilmez", async () => {
    const calls: string[] = [];
    const t: RemoteTransport = { call: async (_to, op) => { calls.push(op); return { opId: "x", result: { machine: "windows" } as never }; } };
    const src = tmp(); const f = makeFile(src, "a", 1, 1);
    const e = await sendPaths(t, { to: "windows", paths: [f] }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(RemoteError); expect(e.code).toBe("failed"); expect(e.message).toMatch(/karşı Agent güncel değil \(xfer yok\); yeniden başlat/);
    expect(calls).toEqual(["ping"]);
  });
  it("aynı üst ad çakışması gönderici tarafında çözülür (harf duyarsız dahil)", async () => {
    const p = await pair(); const src = tmp();
    const a = makeFile(src, "x/a.txt", 3, 1), b = makeFile(src, "y/a.txt", 4, 2), c = makeFile(src, "z/A.TXT", 5, 3);
    const r = await sendPaths(p.mac.transport, { to: "windows", paths: [a, b, c] });
    expect(r.items.map((i) => i.name).sort()).toEqual(["A (2).TXT", "a (1).txt", "a.txt"]);
    expect(names(p.windows.downloads).length).toBe(3);
  });
  it("gönderim sırasında değişen dosya: failed, alıcıda iz yok", async () => {
    const p = await pair(); const src = tmp();
    const f = makeFile(src, "x.bin", 3000, 1);
    let first = true;
    const e = await sendPaths(p.mac.transport, { to: "windows", paths: [f], chunkBytes: 1000, onProgress: () => { if (first) { first = false; appendFileSync(f, "EK"); } } }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(RemoteError); expect(e.message).toMatch(/dosya gönderim sırasında değişti/);
    expect(names(p.windows.downloads)).toEqual([]);
    expect(p.windows.notifier.calls).toEqual([]);
  });
  it("4 GiB sınırı: sahte totalBytes (seyrek dosya) veri göndermeden too_large", async () => {
    if (process.platform === "win32") return;
    const p = await pair(); const src = tmp();
    const f = makeFile(src, "x.bin", 1, 1); require("node:fs").truncateSync(f, 4 * 1024 ** 3 + 1);
    const { w, calls } = spy(p.mac.transport);
    const e = await sendPaths(w, { to: "windows", paths: [f] }).then(() => null, (x) => x);
    expect(e.code).toBe("too_large"); expect(e.message).toMatch(/4 GiB/);
    expect(calls).toEqual([]);
  });
  it("kısmi teslim (failed) sonuçta aynen döner", async () => {
    const t: RemoteTransport = { call: async (_to, op, args: any) => ({ opId: "x", result: (op === "ping" ? { caps: ["xfer"] } : op === "xfer-begin" ? { id: args.id, chunkBytes: 1024, state: "new" } : op === "xfer-chunk" ? { received: 1 } : { items: [], failed: { name: "a", error: "disk" } }) as never }) };
    const src = tmp(); const f = makeFile(src, "a", 1, 1);
    const r = await sendPaths(t, { to: "windows", paths: [f] });
    expect(r.failed).toEqual({ name: "a", error: "disk" });
  });
});

describe("aktarim:A2 uploadBuffer", () => {
  it("bellekteki veriyi tek dosya olarak teslim eder ve commit sonucunu döner", async () => {
    const p = await pair();
    const data = Buffer.from("merhaba".repeat(1000));
    const r = await uploadBuffer(p.mac.transport, "windows", data, { purpose: "file", name: "m.txt" });
    expect(r.items.map((i) => i.name)).toEqual(["m.txt"]);
    expect(readFileSync(join(p.windows.downloads, "m.txt")).equals(data)).toBe(true);
  });
});
