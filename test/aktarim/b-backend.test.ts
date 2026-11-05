import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBackend } from "../../src/clip/backend.js";
import { darwinHelperArgs, darwinHelperScript } from "../../src/clip/backend-darwin.js";
import { winHelperArgs, winHelperScript } from "../../src/clip/backend-win32.js";
import { spawnLineHelper } from "../../src/clip/helper.js";
import type { ClipboardBackend, PersistentHelper, PersistentRunner } from "../../src/clip/types.js";
import { rmTemp } from "../helpers.js";

// aktarim:B backend: satır protokolü (taklit süreçle), yardımcı yaşam döngüsü, komut satırı hijyeni, betik üreticileri.
// Gerçek pano/PowerShell/osascript YOK: yardımcı yerine fixtures/fake-helper.mjs (node) çalışır.
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-helper.mjs");
const live: PersistentHelper[] = []; const backends: ClipboardBackend[] = []; const dirs: string[] = [];
afterEach(async () => { for (const b of backends.splice(0)) await b.close(); for (const h of live.splice(0)) await h.close(); for (const d of dirs.splice(0)) rmTemp(d); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20)); return f(); };

function mk(flagsPerSpawn: string[][] | string[] = [], extra: { argvSeen?: string[][] } = {}) {
  const perSpawn = Array.isArray(flagsPerSpawn[0]) ? (flagsPerSpawn as string[][]) : [flagsPerSpawn as string[]];
  let n = 0;
  const run: PersistentRunner = {
    run: async () => { throw new Error("kullanılmaz"); },
    spawnHelper: (file, args) => {
      extra.argvSeen?.push([file, ...args]);
      const flags = perSpawn[Math.min(n++, perSpawn.length - 1)] ?? [];
      const h = spawnLineHelper(process.execPath, [FAKE, ...flags]); live.push(h); return h;
    },
  };
  const slept: number[] = [];
  const b = createBackend("darwin", run, { sleep: async (ms) => { slept.push(ms); }, timeoutMs: 1500 });
  backends.push(b);
  return { b, slept, spawns: () => n };
}
const T = (s: string) => ({ kind: "text" as const, bytes: Buffer.from(s, "utf8") });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000208020000", "hex");

describe("aktarim:B backend satır protokolü", () => {
  it("yaz → oku gidiş-dönüş: Türkçe/emoji/CRLF birebir; write expectSeq ile; read seq döner", async () => {
    const { b } = mk();
    const s0 = (await b.read()).seq; expect((await b.read()).content).toBeNull();
    const w = await b.write(T("merhaba ğüşiöç 😀\r\nx"), s0);
    expect(w).toMatchObject({ written: true }); expect(w.seqAfter).toBeGreaterThan(s0);
    const r = await b.read(); expect(r.content!.kind).toBe("text"); expect(r.content!.bytes.toString()).toBe("merhaba ğüşiöç 😀\r\nx"); expect(r.seq).toBe(w.seqAfter);
    expect(await b.changeCount()).toBe(w.seqAfter);
  });
  it("bayat expectSeq → written:false, reason local_changed, pano değişmez", async () => {
    const { b } = mk(); const s0 = await b.changeCount();
    await b.write(T("a"), s0);
    const w = await b.write(T("b"), s0);
    expect(w).toMatchObject({ written: false, reason: "local_changed" });
    expect((await b.read()).content!.bytes.toString()).toBe("a");
  });
  it("resim yazma/okuma; metin ve resim birlikteyse yalnız metin döner", async () => {
    const { b } = mk(); await b.write({ kind: "image", bytes: PNG }, await b.changeCount());
    expect((await b.read()).content).toMatchObject({ kind: "image" });
    expect((await b.read()).content!.bytes.equals(PNG)).toBe(true);
    const both = mk(["both"]); await both.b.write(T("yazı"), await both.b.changeCount());
    const st = await spawnState(both.b); expect(st).toBe("text");
  });
  it("okuma sırasında sayaç değişirse bir kez yeniden okur", async () => {
    const { b } = mk(["racy-read"]); await b.write(T("x"), await b.changeCount());
    const r = await b.read(); expect(r.content!.bytes.toString()).toBe("x");
    expect(r.seq).toBe(await b.changeCount());
  });
  it("gecikmeli pano: yazma sonrası ayar süresi (150 ms) bekler, gecikmeli sayaç artışı seqAfter'a katılır", async () => {
    const { b, slept } = mk(["bump-later"]); const s0 = await b.changeCount();
    const w = await b.write(T("x"), s0);
    expect(slept[0]).toBe(150);
    expect(w.seqAfter).toBe(s0 + 1); // sayaç yanıtın ardından artti; durulana dek okundu
    expect(await b.changeCount()).toBe(w.seqAfter);
  });
  it("yardımcı ok:false derse hata; yanıt kimliği uyuşmazsa hata ve yardımcı sıfırlanır", async () => {
    const { b } = mk([["bad-id"], []]);
    await expect(b.read()).rejects.toThrow(/kimlik|uyuşmuyor/);
    expect((await b.read()).content).toBeNull(); // yeni yardımcı
  });
  it("içerik komut satırına girmez: spawn argv'si sabit, metin yalnız stdin'den", async () => {
    const seen: string[][] = []; const { b } = mk([], { argvSeen: seen });
    const evil = "\"; Remove-Item -Recurse $HOME; `calc` $(whoami) '\r\n";
    await b.write(T(evil), await b.changeCount()); await b.read();
    expect(seen).toHaveLength(1);
    expect(seen.flat().some((a) => a.includes("Remove-Item") || a.includes("whoami"))).toBe(false);
    expect((await b.read()).content!.bytes.toString()).toBe(evil);
  });
});

async function spawnState(b: ClipboardBackend): Promise<string | undefined> { return (await b.read()).content?.kind; }

describe("aktarim:B yardımcı yaşam döngüsü (spawnLineHelper)", () => {
  it("zaman aşımında yardımcı öldürülür ve sonraki çağrı yenisini başlatır", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vlad-akt-b-")); dirs.push(dir); const pf = join(dir, "pid"), st = join(dir, "n");
    const { b } = mk([`pid-file=${pf}`, `state=${st}`, "hang-first=1"]);
    await expect(b.changeCount()).rejects.toThrow(/zaman aşımı/);
    const pid1 = Number(readFileSync(pf, "utf8"));
    expect(await waitFor(() => !alive(pid1))).toBe(true);
    expect(await b.changeCount()).toBeGreaterThan(0);
    expect(readFileSync(st, "utf8")).toBe("2");
  });
  it("çökmede istek reddedilir ve sonraki çağrı aynı helper içinde yeniden başlatır", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vlad-akt-b-")); dirs.push(dir); const st = join(dir, "n");
    const { b } = mk([`state=${st}`, "crash-first=2"]);
    await expect(b.changeCount()).rejects.toThrow(/kapandı|çök/);
    await expect(b.changeCount()).rejects.toThrow(/kapandı|çök/);
    expect(await b.changeCount()).toBeGreaterThan(0);
    expect(readFileSync(st, "utf8")).toBe("3");
  });
  it("art arda 3 çöküşten sonra yeniden denenmez (süreç sayısı 3'te kalır)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vlad-akt-b-")); dirs.push(dir); const st = join(dir, "n");
    const { b } = mk([`state=${st}`, "crash-first=99"]);
    for (let i = 0; i < 3; i++) await expect(b.changeCount()).rejects.toThrow(/kapandı|çök/);
    await expect(b.changeCount()).rejects.toThrow(/3 kez|yeniden denenmiyor/);
    await expect(b.changeCount()).rejects.toThrow(/3 kez|yeniden denenmiyor/);
    expect(readFileSync(st, "utf8")).toBe("3");
  });
  it("close() çocuğu öldürür (yetim yok); kapalı yardımcıya gönderim hata; çift close güvenli", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vlad-akt-b-")); dirs.push(dir); const pf = join(dir, "pid");
    const h = spawnLineHelper(process.execPath, [FAKE, `pid-file=${pf}`]); live.push(h);
    expect(JSON.parse(await h.send('1\tcount', 3000))).toMatchObject({ ok: true });
    const pid = Number(readFileSync(pf, "utf8")); expect(alive(pid)).toBe(true);
    await h.close(); await h.close();
    expect(await waitFor(() => !alive(pid))).toBe(true);
    await expect(h.send('2\tcount', 1000)).rejects.toThrow(/kapalı/);
  });
  it("stdin EOF'unda yardımcı kendiliğinden çıkar (taklit süreç sözleşmesi)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vlad-akt-b-")); dirs.push(dir); const pf = join(dir, "pid");
    const c = spawn(process.execPath, [FAKE, `pid-file=${pf}`], { stdio: ["pipe", "ignore", "ignore"] });
    await waitFor(() => existsSync(pf)); c.stdin.end();
    expect(await waitFor(() => !alive(c.pid!))).toBe(true);
  });
  it("eşzamanlı istekler sıraya girer ve yanıtlar karışmaz", async () => {
    const { b } = mk(); const s0 = await b.changeCount();
    const rs = await Promise.all([b.changeCount(), b.write(T("x"), s0), b.changeCount(), b.read()]);
    expect(rs[0]).toBe(s0); expect(rs[1]).toMatchObject({ written: true }); expect(rs[2]).toBeGreaterThan(s0); expect(rs[3].content!.bytes.toString()).toBe("x");
  });
});

describe("aktarim:B platform betikleri ve createBackend", () => {
  it("Windows: -EncodedCommand ile sabit betik; betikte sıra numarası, STA, metin/resim ve yeniden deneme; kullanıcı verisi yok", () => {
    const s = winHelperScript();
    for (const m of ["GetClipboardSequenceNumber", "System.Windows.Forms", "ContainsText", "GetImage", "SetImage", "ImageFormat]::Png", "ReadLine", "ConvertTo-Json", "FromBase64String", "Split"]) expect(s, m).toContain(m);
    expect(winHelperScript()).toBe(s); // deterministik
    const a = winHelperArgs();
    expect(a).toContain("-STA"); expect(a).toContain("-NoProfile");
    const enc = a[a.indexOf("-EncodedCommand") + 1]!;
    expect(Buffer.from(enc, "base64").toString("utf16le")).toBe(s);
  });
  it("macOS: osascript -l JavaScript -e <betik>; changeCount/png/tiff→png/utf8; pano adı yalnız üretici parametresi", () => {
    const s = darwinHelperScript();
    for (const m of ["generalPasteboard", "changeCount", "public.utf8-plain-text", "public.png", "public.tiff", "availableData", "clearContents"]) expect(s, m).toContain(m);
    expect(darwinHelperScript({ pasteboard: "unique" })).toContain("pasteboardWithUniqueName");
    expect(darwinHelperScript({ pasteboard: "unique" })).not.toContain("generalPasteboard");
    expect(darwinHelperArgs()).toEqual(["-l", "JavaScript", "-e", s]);
  });
  it("desteklenmeyen işletim sisteminde anlaşılır hata; gerçek çalıştırıcı native kapalıyken NativeDisabledError", async () => {
    await expect(createBackend("linux").changeCount()).rejects.toThrow(/desteklenmiyor/);
    await expect(createBackend("darwin").changeCount()).rejects.toThrow(/native devre dışı/);
    await expect(createBackend("win32").read()).rejects.toThrow(/native devre dışı/);
  });
});
