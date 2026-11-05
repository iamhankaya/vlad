import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// aktarim:E kalanlar (F-vlad-219/232/235). Gerçek pano/Windows yok: FakeClipboard, betik metni ve sahte fs hatası.
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return { ...real, lstat: async (p: string, ...a: unknown[]) => { if (String(p).includes("tcc-denied")) throw Object.assign(new Error("EPERM: operation not permitted, lstat"), { code: "EPERM" }); return (real.lstat as any)(p, ...a); } };
});
const { ClipSync } = await import("../../src/clip/sync.js");
const { winHelperScript } = await import("../../src/clip/backend-win32.js");
const { sendPaths } = await import("../../src/transfer/send.js");
const { FakeClipboard } = await import("./harness.js");
import type { ClipContent, ClipDeps, ClipPushArgs } from "../../src/clip/types.js";
import type { RemoteTransport } from "../../src/fleet/types.js";

const T0 = 1_900_000_000_000;
const text = (s: string): ClipContent => ({ kind: "text", bytes: Buffer.from(s, "utf8") });
const png = (): Buffer => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(2, 16); b.writeUInt32BE(2, 20); return b; };

describe("aktarim:E F-vlad-232 yerleşme penceresinde tür değişimi", () => {
  it("uzak resim yazıldı, pencerede kullanıcı METİN kopyaladı → yankı sayılmaz, yerel olay olarak gönderilir", async () => {
    const clock = { t: T0 }, cb = new FakeClipboard(), pushed: ClipPushArgs[] = [];
    let n = 0;
    const d: ClipDeps = {
      backend: cb, now: () => clock.t, settleMs: 150, isEnabled: () => true, log: () => {}, rank: 0, peer: "karşı",
      sleep: async () => { if (n++ === 0) cb.setLocal(text("kullanıcı metni")); },
      send: { pushText: async (a) => { pushed.push(a); return "applied"; }, pushImage: async () => "applied" },
    };
    const sync = new ClipSync(d);
    await sync.tick();
    expect(await sync.applyRemote({ kind: "image", bytes: png(), key: [T0 + 1, 1, 1], from: "x" })).toBe("applied");
    clock.t += 20; await sync.tick();
    expect(pushed.map((p) => Buffer.from(p.data, "base64").toString())).toEqual(["kullanıcı metni"]);
    await sync.stop();
  });
});

describe("aktarim:E F-vlad-219 Windows yardımcısı: her yazma denemesinden önce seq", () => {
  const script = winHelperScript();
  it("yazma yolu Retry değil, seq'i HER denemede yeniden doğrulayan korumalı döngüyü kullanır", () => {
    const m = script.match(/function WriteGuarded\(\$f, \$expect\) \{([^\n]*)\n/);
    expect(m, "WriteGuarded tanımı yok").not.toBeNull();
    const body = m![1]!;
    expect(body).toMatch(/for \(/);
    expect(body.indexOf("(Seq) -ne $expect")).toBeGreaterThan(-1);
    expect(body.indexOf("(Seq) -ne $expect")).toBeLessThan(body.indexOf("& $f")); // deneme öncesi kontrol
    const write = script.slice(script.indexOf("'write' {"), script.indexOf("default {"));
    expect(write).not.toMatch(/Retry \{/);
    for (const call of ["SetText", "SetImage", "Clear"]) expect(write).toMatch(new RegExp(`WriteGuarded \\{[^}]*${call}`));
    expect(write).toMatch(/written = \$false/); // korumalı yazma reddedilirse written:false
  });
});

describe("aktarim:E F-vlad-235 macOS TCC izni", () => {
  const t: RemoteTransport = { async call() { throw new Error("ağa çıkılmamalı"); } } as never;
  it("EPERM → anlaşılır macOS dosya izni hatası (yol yok denmez)", async () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const dir = mkdtempSync(join(tmpdir(), "vlad-e-"));
      const e = await sendPaths(t, { to: "windows", paths: [join(dir, "tcc-denied")] }).then(() => null, (x) => x as Error);
      expect(e?.message).toMatch(/macOS dosya izni gerekli.*Gizlilik ve Güvenlik.*Dosyalar ve Klasörler/);
      expect(e?.message).not.toMatch(/yol yok/);
    } finally { Object.defineProperty(process, "platform", real); }
  });
});
describe("aktarim:E F-vlad-235 --notify", () => {
  it("TCC reddi bildirime de anlaşılır metinle girer", async () => {
    const { runSendCommand } = await import("../../src/transfer/cli.js");
    const { defaultConfig } = await import("../../src/kb/config.js");
    const cfg = { ...defaultConfig(), brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 1 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: 1 } }] } as never;
    const calls: { title: string; body: string }[] = [];
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const e = await runSendCommand([join(tmpdir(), "tcc-denied")], { notify: true }, { cfg, self: "mac", transport: { async call() { throw new Error("ağ"); } } as never, notifier: { notify: async (title: string, body: string) => { calls.push({ title, body }); } } as never, write() {}, writeErr() {} }).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(Error);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toMatch(/macOS dosya izni gerekli/);
    } finally { Object.defineProperty(process, "platform", real); }
  });
});
afterEach(() => vi.restoreAllMocks());
