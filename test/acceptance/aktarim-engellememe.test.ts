// aktarim-kabul K3 — engellememe (anti-hedef: aktarım VLAD'ın görev/kb işlerini yavaşlatmamalı/bozmamalı).
// Deterministik: süre ölçümü YOK. Test kancası (latch) aktarımı yayımlama/parça ortasında tutar; bu sırada kontrol op'ları tamamlanmalı.
// Engelleme olursa çağrı kısa `timeoutMs` ile (5 sn) düşer → kırmızı. Süre eşiği iddiası yok.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAktarimPair, type AktarimPair } from "../aktarim/harness.js";
import { b64, bytes, entriesOf, hashesOf, newId, rawUpload, sha256, visible, wire, type RawItem } from "./aktarim-helpers.js";

const pairs: AktarimPair[] = [];
afterEach(async () => { for (const p of pairs.splice(0)) await p.stop(); });
const pair = async (...a: Parameters<typeof startAktarimPair>) => { const p = await startAktarimPair(...a); pairs.push(p); return p; };
const latch = () => { let open!: () => void; const gate = new Promise<void>((r) => { open = r; }); return { gate, open }; };
const T = { timeoutMs: 5000 };

describe("aktarim-kabul: aktarım sürerken Agent'ın diğer op'ları çalışır", () => {
  it("yayımlama (commit) yarıda tutulurken ping her iki yönde ve yeni bir aktarımın begin'i tamamlanır", async () => {
    const l = latch(); let held = false;
    const p = await pair({ windows: { hooks: { beforePublish: async () => { held = true; await l.gate; } } } });
    const items: RawItem[] = [{ path: "a.bin", data: bytes(5000, 1) }];
    const slow = rawUpload(p.mac.transport, "windows", items); // commit latch'te bekler
    slow.catch(() => {}); // erken düşerse (uygulama yok) işlenmemiş ret olmasın; asıl hata aşağıda await ile görünür
    for (let i = 0; i < 2000 && !held; i++) await new Promise((r) => setTimeout(r, 5));
    expect(held).toBe(true);
    // aktarım yarıda; kontrol op'ları engellenmemeli
    const pong = await wire<{ machine: string }>(p.mac.transport, "windows", "ping", {}, T);
    expect(pong.machine).toBe("windows");
    const back = await wire<{ machine: string }>(p.windows.transport, "mac", "ping", {}, T);
    expect(back.machine).toBe("mac");
    const other = await wire<{ state: string }>(p.mac.transport, "windows", "xfer-begin", { id: newId(), purpose: "file", entries: [{ path: "b.bin", kind: "file", size: 3 }] }, T);
    expect(other.state).toBe("new");
    expect(visible(p.windows.downloads)).toEqual([]); // yarım aktarım görünmez
    l.open();
    const done = await slow;
    expect(done.commit!.items).toHaveLength(1);
    expect(visible(p.windows.downloads)).toEqual(["a.bin"]);
  });
  it("uçuşta iki parça beklerken (afterChunk latch) ping ve abort/begin gibi kısa op'lar tamamlanır", async () => {
    const l = latch(); let inflight = 0;
    const p = await pair({ windows: { hooks: { afterChunk: async () => { inflight++; await l.gate; } } } });
    const data = bytes(2000, 2);
    const id = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: [{ path: "x.bin", kind: "file", size: 2000 }] });
    const c1 = wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64(data.subarray(0, 1000)) }, { timeoutMs: 20_000 });
    c1.catch(() => {});
    for (let i = 0; i < 2000 && inflight < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(inflight).toBe(1);
    const pong = await wire<{ machine: string }>(p.mac.transport, "windows", "ping", {}, T);
    expect(pong.machine).toBe("windows");
    const id2 = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id: id2, purpose: "file", entries: [{ path: "y", kind: "file", size: 1 }] }, T);
    await wire(p.mac.transport, "windows", "xfer-abort", { id: id2 }, T);
    l.open();
    await c1;
  });
  it("beyin tarafında da: gelen aktarım (windows → mac) yayımlama ortasındayken mac Agent'ı ping'e yanıt verir", async () => {
    const l = latch(); let held = false;
    const p = await pair({ mac: { hooks: { beforePublish: async () => { held = true; await l.gate; } } } });
    const slow = rawUpload(p.windows.transport, "mac", [{ path: "w.bin", data: bytes(100, 3) }]);
    slow.catch(() => {});
    for (let i = 0; i < 2000 && !held; i++) await new Promise((r) => setTimeout(r, 5));
    expect(held).toBe(true);
    expect((await wire<{ machine: string }>(p.windows.transport, "mac", "ping", {}, T)).machine).toBe("mac");
    l.open();
    await slow;
  });
  it("kontrol op'ları (ping) aktarım sırasında bile yeni op'ların 'caps' alanını döndürür (eski/yeni Agent ayırt edilebilir)", async () => {
    const p = await pair();
    const pong = await wire<{ caps: string[] }>(p.mac.transport, "windows", "ping", {}, T);
    expect(pong.caps).toEqual(expect.arrayContaining(["xfer", "clip"]));
  });
});

describe("aktarim-kabul: aktarım Agent günlüğünü şişirmez / bozmaz", () => {
  it("xfer-* ve clip-push op'ları günlüğe (journal) yazılmaz; parça verisi (base64) günlükte yok", async () => {
    const p = await pair();
    const marker = `akt-j-${Date.now()}`;
    const items: RawItem[] = [{ path: "j.bin", data: bytes(4096, 7) }];
    const id = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: entriesOf(items) }, { opId: `${marker}-b` });
    await wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64((items[0] as { data: Buffer }).data) }, { opId: `${marker}-c` });
    await wire(p.mac.transport, "windows", "xfer-commit", { id, sha256: hashesOf(items) }, { opId: `${marker}-m` });
    await wire(p.windows.transport, "mac", "clip-push", { kind: "text", data: b64("x"), eventTs: Date.now(), rank: 0, counter: 1 }, { opId: `${marker}-p` });
    for (const side of [p.windows, p.mac]) {
      const jf = join(side.stateDir, "journal.jsonl");
      const j = existsSync(jf) ? readFileSync(jf, "utf8") : "";
      expect(j.includes(marker), side.name).toBe(false);
      expect(j.includes(b64((items[0] as { data: Buffer }).data).slice(0, 64)), side.name).toBe(false);
    }
    expect(sha256(readFileSync(join(p.windows.downloads, "j.bin")))).toBe(sha256((items[0] as { data: Buffer }).data));
  });
  it("aynı Agent'a eşzamanlı iki ayrı aktarım birbirini bozmaz (içerikler karışmaz)", async () => {
    const p = await pair();
    const a: RawItem[] = [{ path: "a.bin", data: bytes(3000, 11) }], b: RawItem[] = [{ path: "b.bin", data: bytes(3000, 12) }];
    await Promise.all([rawUpload(p.mac.transport, "windows", a), rawUpload(p.mac.transport, "windows", b)]);
    expect(visible(p.windows.downloads)).toEqual(["a.bin", "b.bin"]);
    expect(sha256(readFileSync(join(p.windows.downloads, "a.bin")))).toBe(sha256((a[0] as { data: Buffer }).data));
    expect(sha256(readFileSync(join(p.windows.downloads, "b.bin")))).toBe(sha256((b[0] as { data: Buffer }).data));
  });
});
