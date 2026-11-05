// aktarim-dogrulama (V, T20261105-10): uçtan uca senaryolar, iki sahte Agent (kablo: gerçek HMAC'li TCP, loopback).
// Gerçek pano/bildirim/İndirilenler yok; her şey temp + FakeClipboard/FakeNotifier.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeFile, startAktarimPair, treeHash, type AktarimPair } from "../aktarim/harness.js";
import { rmTemp } from "../helpers.js";
import { makeHomePair, spawnVlad, startAgent, type RunningAgent } from "../machines/harness.js";
import { image, png, text } from "./aktarim-helpers.js";

const pairs: AktarimPair[] = [];
afterEach(async () => { for (const p of pairs.splice(0)) await p.stop(); });
const pair = async (...a: Parameters<typeof startAktarimPair>) => { const p = await startAktarimPair(...a); pairs.push(p); return p; };

describe("V: pano resmi kablodan (buildAktarim bağlaması)", () => {
  // V-1 (F-vlad-230) T20261105-34'te düzeltildi: buildAktarim clipImage = clip.sink bağlar; bu iki test regresyon koruması.
  it("mac'te kopyalanan resim windows panosuna yazılır", async () => {
    const p = await pair();
    await p.mac.clip.sync.tick(); // açılış taban çizgisi
    const img = png(3, 3, 7);
    p.mac.clipboard.setLocal(image(img));
    await p.mac.clip.sync.tick();
    expect(p.windows.clipboard.writes.length).toBe(1);
    expect(p.windows.clipboard.writes[0]!.kind).toBe("image");
    expect(p.windows.clipboard.writes[0]!.bytes.equals(img)).toBe(true);
    expect(p.mac.clipboard.writes).toEqual([]);
  });
  it("windows'ta kopyalanan resim mac panosuna yazılır", async () => {
    const p = await pair();
    await p.windows.clip.sync.tick();
    const img = png(4, 2, 9);
    p.windows.clipboard.setLocal(image(img));
    await p.windows.clip.sync.tick();
    expect(p.mac.clipboard.writes.length).toBe(1);
    expect(p.mac.clipboard.writes[0]!.bytes.equals(img)).toBe(true);
  });
});

describe("V2: resim panosu kablodan, yankı ve ardışık gönderim", () => {
  it("resim bir kez iletilir, karşı taraf yoklayınca geri yankı olmaz; ardından ters yönde yeni resim gelir", async () => {
    const p = await pair();
    await p.mac.clip.sync.tick(); await p.windows.clip.sync.tick();
    const a = png(3, 3, 11), b = png(5, 2, 13);
    p.mac.clipboard.setLocal(image(a));
    await p.mac.clip.sync.tick();
    await p.windows.clip.sync.tick(); // yankı üretmemeli
    await p.mac.clip.sync.tick();
    expect(p.windows.clipboard.writes.length).toBe(1);
    expect(p.mac.clipboard.writes).toEqual([]);
    p.windows.clipboard.setLocal(image(b));
    await p.windows.clip.sync.tick();
    await p.mac.clip.sync.tick();
    await p.windows.clip.sync.tick();
    expect(p.mac.clipboard.writes.length).toBe(1);
    expect(p.mac.clipboard.writes[0]!.bytes.equals(b)).toBe(true);
    expect(p.windows.clipboard.writes.length).toBe(1);
  });
});

describe("V: kabloda yankı/döngü yok (tek ClipSync örneği)", () => {
  it("metin iki yönde 20 tur: her yazma yalnız bir kez, geri yankı yok", async () => {
    const p = await pair();
    await p.mac.clip.sync.tick(); await p.windows.clip.sync.tick();
    for (let i = 0; i < 20; i++) {
      const side = i % 2 === 0 ? p.mac : p.windows, other = i % 2 === 0 ? p.windows : p.mac;
      side.clipboard.setLocal(text(`tur ${i}`));
      await side.clip.sync.tick();
      await other.clip.sync.tick(); // karşı taraf kendi yoklamasında yankı üretmemeli
      await side.clip.sync.tick();
      expect(other.clipboard.writes.at(-1)!.bytes.toString("utf8")).toBe(`tur ${i}`);
    }
    expect(p.mac.clipboard.writes.length).toBe(10);
    expect(p.windows.clipboard.writes.length).toBe(10);
  });
});

// ---- gerçek süreçler: işçi tarafında gerçek `vlad agent start` alt süreci, beyinde gerçek `vlad send` (dist/cli.js), loopback ----
describe("V: gerçek vlad send → gerçek Agent süreci (loopback)", () => {
  it("dosya + klasör iletilir, ikinci gönderim '(1)' alır, --json çıktısı tutarlı", async () => {
    const homes = makeHomePair({ config: { brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: 7438 } }] } });
    const dl = mkdtempSync(join(tmpdir(), "vlad-akt-v-dl-"));
    const src = mkdtempSync(join(tmpdir(), "vlad-akt-v-src-"));
    // Gerçek kaynak koruması: İndirilenler yalnız temp olmalı.
    expect(realpathSync(dl).startsWith(realpathSync(tmpdir()))).toBe(true);
    const env = { VLAD_NO_NATIVE: "1", VLAD_DOWNLOADS_DIR: dl };
    let agent: RunningAgent | undefined;
    try {
      agent = await startAgent({ ...homes.worker, env: { ...homes.worker.env, ...env } });
      const cfg = { brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: agent.port } }] };
      writeFileSync(join(homes.brain.home, "vlad.config.json"), JSON.stringify(cfg));
      writeFileSync(join(homes.worker.home, "vlad.config.json"), JSON.stringify(cfg));
      const f = makeFile(src, "rapor ğüş 🙂.bin", 3 * 1024 * 1024 + 17, 5);
      const d = join(src, "klasör");
      makeFile(d, "a/b.txt", 100, 2); makeFile(d, "c.bin", 1, 3); mkdirSync(join(d, "boş"), { recursive: true });

      const r1 = spawnVlad(homes.brain, ["send", f, d, "--to", "windows", "--json"], { env });
      expect(r1.code, r1.err).toBe(0);
      const j1 = JSON.parse(r1.out.trim());
      expect(j1.to).toBe("windows");
      expect(j1.items.map((i: { name: string }) => i.name).sort()).toEqual(["klasör", "rapor ğüş 🙂.bin"]);
      expect(readFileSync(join(dl, "rapor ğüş 🙂.bin")).equals(readFileSync(f))).toBe(true);
      expect(treeHash(join(dl, "klasör"))).toBe(treeHash(d));
      expect(readdirSync(dl).filter((n) => n.startsWith(".")).every((n) => readdirSync(join(dl, n)).length === 0 || n === ".vlad-incoming")).toBe(true);

      const r2 = spawnVlad(homes.brain, ["send", f, "--to", "windows"], { env });
      expect(r2.code, r2.err).toBe(0);
      expect(readFileSync(join(dl, "rapor ğüş 🙂 (1).bin")).equals(readFileSync(f))).toBe(true);
      expect(readFileSync(join(dl, "rapor ğüş 🙂.bin")).equals(readFileSync(f))).toBe(true); // ilki ezilmedi
    } finally { await agent?.stop(); homes.cleanup(); rmTemp(dl); rmTemp(src); }
  }, 90_000);

  it("Agent kapatılınca gönderim çıkış 75, yarım dosya İndirilenler'de görünmez", async () => {
    const homes = makeHomePair({ config: { brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: 7438 } }] } });
    const dl = mkdtempSync(join(tmpdir(), "vlad-akt-v-dl-"));
    const src = mkdtempSync(join(tmpdir(), "vlad-akt-v-src-"));
    expect(realpathSync(dl).startsWith(realpathSync(tmpdir()))).toBe(true);
    const env = { VLAD_NO_NATIVE: "1", VLAD_DOWNLOADS_DIR: dl };
    try {
      const agent = await startAgent({ ...homes.worker, env: { ...homes.worker.env, ...env } });
      const port = agent.port;
      await agent.stop();
      const cfg = { brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port } }] };
      writeFileSync(join(homes.brain.home, "vlad.config.json"), JSON.stringify(cfg));
      const f = makeFile(src, "x.bin", 4096, 1);
      const r = spawnVlad(homes.brain, ["send", f, "--to", "windows"], { env });
      expect(r.code, r.err).toBe(75);
      expect(readdirSync(dl).filter((n) => n !== ".vlad-incoming")).toEqual([]);
    } finally { homes.cleanup(); rmTemp(dl); rmTemp(src); }
  }, 60_000);
});
