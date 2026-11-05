// aktarim-kabul K2 — ortak pano: yankı/döngü yok, son yazan kazanır, yerel kopya ezilmez, aç/kapa, sınırlar.
// Yalnız sözleşme: ClipboardBackend/ClipDeps/ClipReceiver imzaları, harness (FakeClipboard) ve op yüzeyi. Uygulama bitene dek kırmızı.
// Süre/uyku yok: saat elle ilerler (`advance`), `sleep` anında döner, yoklama `tick()` ile elle sürülür.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CLIP_MAX_IMAGE_BYTES, CLIP_MAX_TEXT_BYTES, type ClipPushArgs } from "../../src/clip/types.js";
import { CLOCK_SKEW_MS } from "../../src/machines/types.js";
import { FakeClipboard, startAktarimPair, type AktarimPair } from "../aktarim/harness.js";
import { b64, clipPair, clipResult, codeOf, hugePng, image, png, text, wire, type ClipHarness } from "./aktarim-helpers.js";

const pairs: AktarimPair[] = [];
const hs: ClipHarness[] = [];
afterEach(async () => { for (const p of pairs.splice(0)) await p.stop(); for (const h of hs.splice(0)) await h.stop(); });
const pair = async (...a: Parameters<typeof startAktarimPair>) => { const p = await startAktarimPair(...a); pairs.push(p); return p; };
const cp = (...a: Parameters<typeof clipPair>) => { const h = clipPair(...a); hs.push(h); return h; };
const wirePush = async (t: Parameters<typeof wire>[0], to: string, args: unknown, o?: Parameters<typeof wire>[4]) => clipResult(await wire(t, to, "clip-push", args, o));
const push = (over: Partial<ClipPushArgs> & { s?: string } = {}): ClipPushArgs => ({ kind: "text", data: b64(over.s ?? "merhaba"), eventTs: Date.now(), rank: 1, counter: 1, ...over });
const last = (cb: FakeClipboard) => cb.writes[cb.writes.length - 1]?.bytes.toString("utf8");

describe("aktarim-kabul: pano iki yönde (Agent'lar üzerinden, kabloda)", () => {
  it("mac'te kopyalanan metin windows panosuna yazılır", async () => {
    const p = await pair();
    await p.mac.clip.sync.tick(); // açılış taban çizgisi
    p.mac.clipboard.setLocal(text("Merhaba dünya ğüşiöç 🙂"));
    await p.mac.clip.sync.tick();
    expect(last(p.windows.clipboard)).toBe("Merhaba dünya ğüşiöç 🙂");
    expect(p.mac.clipboard.writes).toEqual([]); // kendi panosuna geri yazılmaz
  });
  it("windows'ta kopyalanan metin mac panosuna yazılır", async () => {
    const p = await pair();
    await p.windows.clip.sync.tick();
    p.windows.clipboard.setLocal(text("şifre: p@ss w0rd\nikinci satır"));
    await p.windows.clip.sync.tick();
    expect(last(p.mac.clipboard)).toBe("şifre: p@ss w0rd\nikinci satır");
    expect(p.windows.clipboard.writes).toEqual([]);
  });
  it("clip-push kablodan: metin uygulanır, panoya yalnız içerik yazılır (komut olarak yorumlanmaz)", async () => {
    const p = await pair();
    const evil = "$(rm -rf ~); `calc`; \"; shutdown /s\r\n";
    const r = await wirePush(p.mac.transport, "windows", push({ s: evil, eventTs: Date.now(), rank: 1, counter: 1 }));
    expect(r).toBe("applied");
    expect(last(p.windows.clipboard)).toBe(evil);
  });
  it("kapalı alıcı: clip-push reddedilir ('disabled'), pano değişmez", async () => {
    const p = await pair({ windows: { clipEnabled: false } });
    expect(await wirePush(p.mac.transport, "windows", push())).toBe("disabled");
    expect(p.windows.clipboard.writes).toEqual([]);
  });
});

describe("aktarim-kabul: metin ve resim, iki yönde (süreç içi uçlar)", () => {
  it("metin a → b ve b → a; CRLF dönüşümü yapan platformda da içerik ulaşır", async () => {
    const h = cp({ b: { transformOnWrite: (c) => (c.kind === "text" ? text(c.bytes.toString("utf8").replace(/\n/g, "\r\n")) : c) } });
    await h.prime();
    h.a.cb.setLocal(text("x\ny")); h.advance(); await h.a.tick();
    expect(h.b.content()!.replace(/\r\n/g, "\n")).toBe("x\ny");
    h.advance(); h.b.cb.setLocal(text("cevap")); h.advance(); await h.b.tick();
    expect(h.a.content()).toBe("cevap");
  });
  it("resim a → b ve b → a: PNG baytları birebir taşınır", async () => {
    const h = cp();
    await h.prime();
    const p1 = png(3, 3, 1), p2 = png(4, 2, 2);
    h.a.cb.setLocal(image(p1)); h.advance(); await h.a.tick();
    expect(h.b.cb.writes.at(-1)).toMatchObject({ kind: "image" });
    expect(h.b.cb.writes.at(-1)!.bytes.equals(p1)).toBe(true);
    h.advance(); h.b.cb.setLocal(image(p2)); h.advance(); await h.b.tick();
    expect(h.a.cb.writes.at(-1)!.bytes.equals(p2)).toBe(true);
  });
  it("bozuk PNG (imza yok / piksel sınırı aşımı) panoya yazılmaz", async () => {
    const h = cp();
    await h.prime();
    const sink = h.b.recv.sink;
    expect(await sink.apply(Buffer.from("png değil"), { eventTs: h.advance(), rank: 0 }, "windows")).not.toBe("applied");
    expect(await sink.apply(hugePng(), { eventTs: h.advance(), rank: 0 }, "windows")).not.toBe("applied");
    expect(h.b.cb.writes).toEqual([]);
  });
  it("açılışta panoda zaten olan içerik yeni olay sayılmaz (taban çizgisi): ilk tick göndermez", async () => {
    const h = cp();
    h.a.cb.setLocal(text("önceden vardı"));
    await h.a.tick();
    expect(h.a.pushes).toBe(0);
    expect(h.b.cb.writes).toEqual([]);
  });
});

describe("aktarim-kabul: yankı / döngü yok", () => {
  const run = async (h: ClipHarness, kind: "text" | "image", rounds: number) => {
    let genuine = 0;
    for (let i = 0; i < rounds; i++) {
      const side = i % 2 === 0 ? h.a : h.b, other = side === h.a ? h.b : h.a;
      h.advance(); side.cb.setLocal(kind === "text" ? text(`değer ${i}\nikinci`) : image(png(2 + (i % 3), 2, i)));
      genuine++;
      h.advance(); await side.tick();
      h.advance(); await other.tick(); // alıcı kendi yazdığını geri göndermemeli
      h.advance(); await side.tick();
      h.advance(); await other.tick();
    }
    return genuine;
  };
  it("metin: 120 tur, bumpPerWrite:2 ve CRLF dönüşümlü pano — gönderim sayısı yalnız gerçek yerel olay sayısı kadar", async () => {
    const crlf = (c: { kind: "text" | "image"; bytes: Buffer }) => (c.kind === "text" ? text(c.bytes.toString("utf8").replace(/\n/g, "\r\n")) : c);
    const h = cp({ a: { bumpPerWrite: 2, transformOnWrite: crlf }, b: { bumpPerWrite: 2, transformOnWrite: crlf, readDelay: 1 } });
    await h.prime();
    const genuine = await run(h, "text", 120);
    expect(h.a.pushes + h.b.pushes).toBe(genuine);
    // her taraf yalnız karşıdan gelenleri yazdı (kendi olayını geri yazmadı)
    expect(h.a.cb.writes.length).toBe(h.b.pushes);
    expect(h.b.cb.writes.length).toBe(h.a.pushes);
  }, 60_000);
  it("resim: 60 tur, yeniden kodlayan pano (baytlar değişir) — yankı yok", async () => {
    const recode = (c: { kind: "text" | "image"; bytes: Buffer }) => (c.kind === "image" ? image(Buffer.concat([c.bytes, Buffer.from([0])])) : c);
    const h = cp({ a: { bumpPerWrite: 2, transformOnWrite: recode }, b: { transformOnWrite: recode } });
    await h.prime();
    const genuine = await run(h, "image", 60);
    expect(h.a.pushes + h.b.pushes).toBe(genuine);
    expect(h.a.cb.writes.length).toBe(h.b.pushes);
    expect(h.b.cb.writes.length).toBe(h.a.pushes);
  }, 60_000);
  it("sakin pano: yeni olay yokken tekrarlanan yoklama hiçbir şey göndermez / yazmaz", async () => {
    const h = cp();
    await h.prime();
    h.a.cb.setLocal(text("bir")); h.advance(); await h.a.tick(); await h.b.tick();
    const [pa, pb, wa, wb] = [h.a.pushes, h.b.pushes, h.a.cb.writes.length, h.b.cb.writes.length];
    for (let i = 0; i < 50; i++) { h.advance(); await h.a.tick(); await h.b.tick(); }
    expect([h.a.pushes, h.b.pushes, h.a.cb.writes.length, h.b.cb.writes.length]).toEqual([pa, pb, wa, wb]);
  });
  it("kullanıcı uzaktan geleni yeniden kopyalarsa bu gerçek yerel olaydır ve gönderilir", async () => {
    const h = cp();
    await h.prime();
    h.a.cb.setLocal(text("ortak")); h.advance(); await h.a.tick();
    h.advance(); await h.b.tick();
    const before = h.b.pushes;
    h.advance(); h.b.cb.setLocal(text("ortak")); h.advance(); await h.b.tick();
    expect(h.b.pushes).toBe(before + 1);
  });
});

describe("aktarim-kabul: son yazan kazanır, yerel kopya ezilmez", () => {
  it("daha yeni olay eskisini geçer: iki taraf sırayla kopyalar, ikisi de en yenisini gösterir", async () => {
    const h = cp();
    await h.prime();
    h.a.cb.setLocal(text("eski")); h.advance(); await h.a.tick();
    h.advance(1000); h.b.cb.setLocal(text("yeni")); h.advance(); await h.b.tick();
    h.advance(); await h.a.tick(); await h.b.tick();
    expect(h.a.content()).toBe("yeni");
    expect(h.b.content()).toBe("yeni");
  });
  it("eski olay anahtarıyla gelen uzak değer panoyu ezmez ('stale'), yazma olmaz", async () => {
    const p = await pair();
    const t = Date.now();
    expect(await wirePush(p.mac.transport, "windows", push({ s: "yeni", eventTs: t, rank: 1, counter: 2 }))).toBe("applied");
    expect(await wirePush(p.mac.transport, "windows", push({ s: "eski", eventTs: t - 5000, rank: 1, counter: 1 }))).toBe("stale");
    expect(p.windows.clipboard.writes.map((w) => w.bytes.toString())).toEqual(["yeni"]);
  });
  it("eşit zamanda beyin (rank 1) kazanır", async () => {
    const h = cp();
    await h.prime();
    const key = h.advance();
    const rA = await h.a.recv.sync.applyRemote({ kind: "text", bytes: Buffer.from("beyinden"), key: [key, 1, 1], from: "mac" });
    const rB = await h.a.recv.sync.applyRemote({ kind: "text", bytes: Buffer.from("işçiden"), key: [key, 0, 99], from: "windows" });
    expect(rA).toBe("applied");
    expect(rB).toBe("stale");
    expect(h.a.content()).toBe("beyinden");
  });
  it("yerel kopya, uzak değer okunup yazılana kadar değiştiyse uzak değer yerel kopyayı ezmez", async () => {
    // Okuma anında anlık görüntü alınır, sonra latch'te bekler; tam o aralıkta kullanıcı kopyalar (belirlenimci, süre yok).
    class Latched extends FakeClipboard {
      hold: Promise<void> = Promise.resolve();
      onRead?: () => void;
      override async read() { const r = await super.read(); this.onRead?.(); await this.hold; return r; }
    }
    const { createClipReceiver } = await import("../../src/clip/receive.js");
    const lc = new Latched();
    let t = 1_900_000_000_000;
    const recv = createClipReceiver({ backend: lc, now: () => t, sleep: async () => {}, isEnabled: () => true, log: () => {}, rank: 1, peer: "windows", autoStart: false, settleMs: 0, send: { pushText: async () => "applied", pushImage: async () => "applied" } });
    await recv.sync.tick(); // taban çizgisi
    lc.setLocal(text("eski yerel"));
    let release!: () => void;
    lc.hold = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { lc.onRead = r; });
    await recv.sync.tick(); // kullanıcının görülmemiş kopyası uzak değerden önce yoklanır (F-vlad-212)
    t += 10;
    const pending = recv.ops["clip-push"](push({ s: "uzaktan", eventTs: t, rank: 0, counter: 1 }), { from: "windows", opId: randomUUID() });
    pending.catch(() => {});
    await entered;
    lc.setLocal(text("kullanıcı şimdi kopyaladı")); // okuma ile yazma arasında kullanıcı kopyaladı
    lc.onRead = undefined;
    release();
    await pending.catch(() => {});
    expect((await lc.read()).content!.bytes.toString("utf8")).toBe("kullanıcı şimdi kopyaladı");
    // alıcı bozulmadı: gecikme olmadan gelen daha yeni uzak değer normal uygulanır (stub/ölü alıcıdan ayırt eder)
    await recv.sync.tick(); // kullanıcının kopyası yoklanır; ondan SONRAKİ uzak değer geçerlidir
    t += 10;
    expect(clipResult(await recv.ops["clip-push"](push({ s: "sonraki uzak", eventTs: t, rank: 0, counter: 2 }), { from: "windows", opId: randomUUID() }))).toBe("applied");
    expect((await lc.read()).content!.bytes.toString("utf8")).toBe("sonraki uzak");
  });
});

describe("aktarim-kabul: aç / kapa", () => {
  it("gönderen kapalıyken yoklama göndermez; açılınca yeni olaylar gider", async () => {
    const h = cp();
    await h.prime();
    h.a.enabled = false;
    h.a.cb.setLocal(text("kapalıyken")); h.advance(); await h.a.tick();
    expect(h.a.pushes).toBe(0);
    h.a.enabled = true;
    h.advance(); h.a.cb.setLocal(text("açıkken")); h.advance(); await h.a.tick();
    expect(h.b.content()).toBe("açıkken");
  });
  it("alıcı kapalıyken metin ve resim itme reddedilir; açılınca kabul edilir", async () => {
    const h = cp();
    await h.prime();
    h.b.enabled = false;
    h.a.cb.setLocal(text("x")); h.advance(); await h.a.tick();
    expect(h.b.cb.writes).toEqual([]);
    expect(h.b.recv.sink.enabled()).toBe(false);
    expect(await h.b.recv.sink.apply(png(), { eventTs: h.advance(), rank: 0 }, "windows")).toBe("disabled");
    expect(h.b.cb.writes).toEqual([]);
    h.b.enabled = true;
    expect(h.b.recv.sink.enabled()).toBe(true);
    h.advance(); h.a.cb.setLocal(text("y")); h.advance(); await h.a.tick();
    expect(h.b.content()).toBe("y");
  });
});

describe("aktarim-kabul: sınırlar", () => {
  it("metin 1 MiB'a kadar senkronlanır; 1 MiB + 1 bayt senkronlanmaz (yerel günlüğe not)", async () => {
    const h = cp();
    await h.prime();
    h.a.cb.setLocal(text("a".repeat(CLIP_MAX_TEXT_BYTES))); h.advance(); await h.a.tick();
    expect(h.b.content()!.length).toBe(CLIP_MAX_TEXT_BYTES);
    const before = h.a.pushes;
    h.advance(); h.a.cb.setLocal(text("b".repeat(CLIP_MAX_TEXT_BYTES + 1))); h.advance(); await h.a.tick();
    expect(h.a.pushes).toBe(before);
    expect(h.b.content()!.startsWith("a")).toBe(true);
  });
  it("alıcı da kendi sınırını uygular: 1 MiB + 1 bayt itme uygulanmaz", async () => {
    const h = cp();
    await h.prime();
    const r = await h.b.recv.sync.applyRemote({ kind: "text", bytes: Buffer.alloc(CLIP_MAX_TEXT_BYTES + 1, 0x61), key: [h.advance(), 0, 1], from: "windows" });
    expect(r).toBe("too_large");
    expect(h.b.cb.writes).toEqual([]);
  });
  it("resim 20 MiB sınırı: alıcı aşan resmi uygulamaz", async () => {
    const h = cp();
    await h.prime();
    const r = await h.b.recv.sync.applyRemote({ kind: "image", bytes: Buffer.alloc(CLIP_MAX_IMAGE_BYTES + 1), key: [h.advance(), 0, 1], from: "windows" });
    expect(["too_large", "bad_image"]).toContain(r);
    expect(h.b.cb.writes).toEqual([]);
  });
  it("geçersiz UTF-8 ile gelen clip-push reddedilir, panoya yazılmaz", async () => {
    const p = await pair();
    const bad = Buffer.from([0xff, 0xfe, 0xfa, 0x80]);
    const code = await codeOf(wirePush(p.mac.transport, "windows", push({ data: bad.toString("base64"), eventTs: Date.now() })));
    expect(code === "bad_request" || code === "ok").toBe(true); // ok ise sonucu 'applied' OLMAMALI
    if (code === "ok") expect(await wirePush(p.mac.transport, "windows", push({ data: bad.toString("base64"), eventTs: Date.now() + 1, counter: 2 }))).not.toBe("applied");
    expect(p.windows.clipboard.writes.some((w) => w.bytes.equals(bad))).toBe(false);
  });
  it("gelecekteki olay zamanı (> şimdi + saat sapması) reddedilir", async () => {
    const p = await pair();
    expect(await wirePush(p.mac.transport, "windows", push({ s: "şimdiki", eventTs: Date.now(), counter: 1 }))).toBe("applied"); // alıcı canlı
    const code = await codeOf(wirePush(p.mac.transport, "windows", push({ s: "gelecek", eventTs: Date.now() + CLOCK_SKEW_MS + 60_000, counter: 2 })));
    expect(["bad_request", "failed", "stale"]).toContain(code);
    expect(p.windows.clipboard.writes.map((w) => w.bytes.toString())).toEqual(["şimdiki"]);
  });
});
