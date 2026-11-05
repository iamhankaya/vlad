// aktarim-kabul K4 — tekrar oynatma ve ayrık sözleşmeler (clip-image). Kablo seviyesi: aynı istek iki kez → bir kez uygulanır.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLIP_MAX_IMAGE_BYTES } from "../../src/clip/types.js";
import { startAktarimPair, type AktarimPair } from "../aktarim/harness.js";
import { XFER_STAGING_DIR } from "../../src/transfer/types.js";
import { RecordingSink, b64, bytes, codeOf, entriesOf, hashesOf, hugePng, listAll, localXfer, newId, png, sha256, visible, wire, type LocalXfer } from "./aktarim-helpers.js";

const pairs: AktarimPair[] = [];
const locals: LocalXfer[] = [];
afterEach(async () => { for (const p of pairs.splice(0)) await p.stop(); for (const l of locals.splice(0)) l.stop(); });
const pair = async (...a: Parameters<typeof startAktarimPair>) => { const p = await startAktarimPair(...a); pairs.push(p); return p; };
const local = (...a: Parameters<typeof localXfer>) => { const l = localXfer(...a); locals.push(l); return l; };

describe("aktarim-kabul: tekrar oynatma — dosya", () => {
  it("aynı xfer-chunk iki kez (aynı opId, aynı veri): bir kez uygulanır, alınan bayt artmaz, dosya bozulmaz", async () => {
    const p = await pair();
    const data = bytes(2000, 21), id = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: [{ path: "r.bin", kind: "file", size: 2000 }] });
    const args = { id, entry: 0, offset: 0, data: b64(data) };
    const r1 = await wire<{ received: number }>(p.mac.transport, "windows", "xfer-chunk", args, { opId: "akt-replay-chunk" });
    const r2 = await wire<{ received: number }>(p.mac.transport, "windows", "xfer-chunk", args, { opId: "akt-replay-chunk" });
    expect(r1.received).toBe(2000);
    expect(r2.received).toBe(2000);
    await wire(p.mac.transport, "windows", "xfer-commit", { id, sha256: [sha256(data)] });
    expect(sha256(readFileSync(join(p.windows.downloads, "r.bin")))).toBe(sha256(data));
    expect(visible(p.windows.downloads)).toEqual(["r.bin"]);
  });
  it("aynı offset'e FARKLI veri gelirse conflict; kısmi örtüşme ve ileri atlama da conflict; teslim bozulmaz", async () => {
    const p = await pair();
    const data = bytes(1000, 22), id = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: [{ path: "c.bin", kind: "file", size: 1000 }] });
    await wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64(data.subarray(0, 400)) });
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64(bytes(400, 99)) }))).toBe("conflict");
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 200, data: b64(data.subarray(200, 600)) }))).toBe("conflict"); // kısmi örtüşme
    expect(await codeOf(wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 800, data: b64(data.subarray(800)) }))).toBe("conflict"); // ileri atlama
    await wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 400, data: b64(data.subarray(400)) });
    await wire(p.mac.transport, "windows", "xfer-commit", { id, sha256: [sha256(data)] });
    expect(sha256(readFileSync(join(p.windows.downloads, "c.bin")))).toBe(sha256(data));
  });
  it("aynı xfer-commit iki kez: tek teslim ('t (1).bin' oluşmaz), tek bildirim, ikinci yanıt aynı öğeleri verir", async () => {
    const p = await pair();
    const data = bytes(300, 23), id = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: entriesOf([{ path: "t.bin", data }]) });
    await wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64(data) });
    const a = await wire<{ items: { name: string }[] }>(p.mac.transport, "windows", "xfer-commit", { id, sha256: hashesOf([{ path: "t.bin", data }]) }, { opId: "akt-replay-commit" });
    const b = await wire<{ items: { name: string }[] }>(p.mac.transport, "windows", "xfer-commit", { id, sha256: hashesOf([{ path: "t.bin", data }]) }, { opId: "akt-replay-commit" });
    expect(b.items).toEqual(a.items);
    expect(visible(p.windows.downloads)).toEqual(["t.bin"]);
    expect(p.windows.notifier.calls).toHaveLength(1);
  });
  it("eşzamanlı çift commit: tek teslim", async () => {
    const p = await pair();
    const data = bytes(300, 24), id = newId();
    await wire(p.mac.transport, "windows", "xfer-begin", { id, purpose: "file", entries: entriesOf([{ path: "e.bin", data }]) });
    await wire(p.mac.transport, "windows", "xfer-chunk", { id, entry: 0, offset: 0, data: b64(data) });
    const sha = hashesOf([{ path: "e.bin", data }]);
    const res = await Promise.allSettled([wire(p.mac.transport, "windows", "xfer-commit", { id, sha256: sha }), wire(p.mac.transport, "windows", "xfer-commit", { id, sha256: sha })]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(visible(p.windows.downloads)).toEqual(["e.bin"]);
    expect(p.windows.notifier.calls).toHaveLength(1);
  });
  it("başka bir kimlik (from) aynı aktarım id'sini kullanamaz: windows'un id'sine mac'ten begin/chunk → conflict/not_found, teslim değişmez", async () => {
    const l = local();
    const id = newId();
    await l.call("xfer-begin", { id, purpose: "file", entries: [{ path: "k.bin", kind: "file", size: 3 }] }, "windows");
    expect(["conflict", "not_found"]).toContain(await codeOf(l.call("xfer-begin", { id, purpose: "file", entries: [{ path: "k.bin", kind: "file", size: 3 }] }, "mac")));
    expect(["conflict", "not_found"]).toContain(await codeOf(l.call("xfer-chunk", { id, entry: 0, offset: 0, data: b64("abc") }, "mac")));
    expect(["conflict", "not_found"]).toContain(await codeOf(l.call("xfer-commit", { id, sha256: [sha256("abc")] }, "mac")));
    expect(visible(l.downloads)).toEqual([]);
  });
  it("aynı id, farklı manifest ile begin → conflict; aynı manifestle begin idempotan", async () => {
    const l = local();
    const id = newId();
    const e1 = [{ path: "m.bin", kind: "file" as const, size: 3 }];
    await l.call("xfer-begin", { id, purpose: "file", entries: e1 });
    await expect(l.call("xfer-begin", { id, purpose: "file", entries: e1 })).resolves.toMatchObject({ state: "receiving" });
    expect(await codeOf(l.call("xfer-begin", { id, purpose: "file", entries: [{ path: "m.bin", kind: "file", size: 4 }] }))).toBe("conflict");
  });
});

describe("aktarim-kabul: tekrar oynatma — pano", () => {
  it("aynı clip-push iki kez: bir kez 'applied', ikincisi 'stale'; panoya bir yazma", async () => {
    const p = await pair();
    const args = { kind: "text", data: b64("bir kez"), eventTs: Date.now(), rank: 1, counter: 5 };
    expect(await wire(p.mac.transport, "windows", "clip-push", args, { opId: "akt-replay-clip" })).toBe("applied");
    expect(await wire(p.mac.transport, "windows", "clip-push", args, { opId: "akt-replay-clip" })).toBe("stale");
    expect(p.windows.clipboard.writes).toHaveLength(1);
  });
  it("kayıttan sonra tekrar oynatılan eski clip-push, kullanıcının sonradan yaptığı kopyayı ezmez", async () => {
    const p = await pair();
    const t = Date.now();
    const old = { kind: "text", data: b64("eski"), eventTs: t, rank: 1, counter: 1 };
    await wire(p.mac.transport, "windows", "clip-push", old);
    await wire(p.mac.transport, "windows", "clip-push", { kind: "text", data: b64("yeni"), eventTs: t + 1000, rank: 1, counter: 2 });
    expect(await wire(p.mac.transport, "windows", "clip-push", old)).toBe("stale");
    expect(p.windows.clipboard.writes.map((w) => w.bytes.toString())).toEqual(["eski", "yeni"]);
  });
});

describe("aktarim-kabul: clip-image ayrık sözleşmesi (dosya teslimine düşmez)", () => {
  const png1 = png(2, 2, 1);
  const img = [{ path: "clip.png", data: png1 }];
  const meta = (ts = Date.now()) => ({ eventTs: ts, rank: 0 });
  it("alıcıda sink kayıtlı değil → begin reddedilir (failed), İndirilenler'de iz yok, bildirim yok", async () => {
    const l = local();
    expect(await codeOf(l.upload(img, { purpose: "clip-image", meta: meta() }))).toBe("failed");
    expect(listAll(l.downloads)).toEqual([]);
    expect(l.notifier.calls).toEqual([]);
  });
  it("sink kapalı (pano 'off') → begin reddedilir", async () => {
    const sink = new RecordingSink(); sink.on = false;
    const l = local({ clipImage: sink });
    expect(await codeOf(l.upload(img, { purpose: "clip-image", meta: meta() }))).toBe("failed");
    expect(sink.applied).toEqual([]);
    expect(listAll(l.downloads)).toEqual([]);
  });
  it("kabul: PNG sink'e uygulanır, commit sonucunda clip:'applied'; İndirilenler'de iz ve bildirim yok, items boş", async () => {
    const sink = new RecordingSink();
    const l = local({ clipImage: sink });
    const { commit } = await l.upload(img, { purpose: "clip-image", meta: meta(1234) });
    expect(commit!.clip).toBe("applied");
    expect(commit!.items).toEqual([]);
    expect(sink.applied).toHaveLength(1);
    expect(sink.applied[0]!.png.equals(png1)).toBe(true);
    expect(sink.applied[0]!.meta).toEqual({ eventTs: 1234, rank: 0 });
    expect(sink.applied[0]!.from).toBe("windows");
    expect(visible(l.downloads)).toEqual([]);
    expect(l.notifier.calls).toEqual([]);
  });
  it("aynı clip-image commit tekrarı sink'i ikinci kez çağırmaz (çift uygulama yok)", async () => {
    const sink = new RecordingSink();
    const l = local({ clipImage: sink });
    const { id } = await l.upload(img, { purpose: "clip-image", meta: meta() });
    await l.call("xfer-commit", { id, sha256: [sha256(png1)] }).catch(() => {});
    expect(sink.applied).toHaveLength(1);
  });
  it("sink 'stale' derse commit sonucu clip:'stale' taşır", async () => {
    const sink = new RecordingSink(); sink.result = "stale";
    const l = local({ clipImage: sink });
    const { commit } = await l.upload(img, { purpose: "clip-image", meta: meta() });
    expect(commit!.clip).toBe("stale");
  });
  it("20 MiB + 1 bayt begin'de reddedilir (veri gönderilmeden)", async () => {
    const l = local({ clipImage: new RecordingSink() });
    const code = await codeOf(l.call("xfer-begin", { id: newId(), purpose: "clip-image", entries: [{ path: "clip.png", kind: "file", size: CLIP_MAX_IMAGE_BYTES + 1 }], meta: meta() }));
    expect(["too_large", "bad_request"]).toContain(code);
  });
  it.each([
    ["eventTs yok", {}],
    ["rank geçersiz", { eventTs: 1, rank: 2 }],
    ["eventTs sayı değil", { eventTs: "dün", rank: 0 }],
  ])("meta geçersiz (%s) → bad_request", async (_n, m) => {
    const l = local({ clipImage: new RecordingSink() });
    expect(await codeOf(l.call("xfer-begin", { id: newId(), purpose: "clip-image", entries: [{ path: "clip.png", kind: "file", size: png1.length }], meta: m }))).toBe("bad_request");
  });
  it("tek dosya olmayan clip-image manifesti (iki girdi / dizin) reddedilir", async () => {
    const l = local({ clipImage: new RecordingSink() });
    expect(["bad_request", "failed"]).toContain(await codeOf(l.call("xfer-begin", { id: newId(), purpose: "clip-image", entries: [{ path: "a.png", kind: "file", size: 1 }, { path: "b.png", kind: "file", size: 1 }], meta: meta() })));
    expect(["bad_request", "failed"]).toContain(await codeOf(l.call("xfer-begin", { id: newId(), purpose: "clip-image", entries: [{ path: "d", kind: "dir", size: 0 }], meta: meta() })));
    expect(await codeOf(l.call("xfer-begin", { id: newId(), purpose: "clip-image", entries: [{ path: "clip.png", kind: "file", size: 10 }], meta: meta() }))).toBe("ok"); // geçerli manifest kabul (alıcı canlı)
  });
  it.each([
    ["PNG imzası yok", Buffer.from("bu bir png değil")],
    ["piksel sınırı (w*h > 64M)", hugePng()],
  ])("bozuk resim (%s): commit bad_request, sink çağrılmaz, hazırlık temizlenir", async (_n, bad) => {
    const sink = new RecordingSink();
    const l = local({ clipImage: sink });
    expect(await codeOf(l.upload([{ path: "clip.png", data: bad }], { purpose: "clip-image", meta: meta() }))).toBe("bad_request");
    expect(sink.applied).toEqual([]);
    expect(visible(l.downloads)).toEqual([]);
    const staging = join(l.downloads, XFER_STAGING_DIR);
    const left = existsSync(staging) ? readdirSync(staging) : [];
    expect(left).toEqual([]); // hata yolunda hazırlık silinir
    expect(l.notifier.calls).toEqual([]);
  });
});
