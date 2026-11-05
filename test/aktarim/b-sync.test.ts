import { afterEach, describe, expect, it, vi } from "vitest";
import { ClipSync, semanticHash } from "../../src/clip/sync.js";
import { CLIP_MAX_IMAGE_BYTES, CLIP_MAX_TEXT_BYTES, CLIP_POLL_MS, type ClipContent, type ClipDeps, type ClipPushArgs } from "../../src/clip/types.js";
import { FakeClipboard } from "./harness.js";

// aktarim:B ClipSync birimleri. Saat elle ilerler, uyku yok; gerçek pano yok (FakeClipboard).
const T0 = 1_900_000_000_000;
const text = (s: string): ClipContent => ({ kind: "text", bytes: Buffer.from(s, "utf8") });
const pngBytes = (w = 2, h = 2): Buffer => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

interface Rig { cb: FakeClipboard; sync: ClipSync; clock: { t: number }; pushed: ClipPushArgs[]; images: Buffer[]; enabled: { v: boolean }; fail: { n: number; result: "applied" | "stale" | "disabled" }; logs: string[] }
const live: ClipSync[] = [];
afterEach(async () => { vi.useRealTimers(); for (const s of live.splice(0)) await s.stop(); });
function rig(o: { cb?: ConstructorParameters<typeof FakeClipboard>[0]; rank?: 0 | 1; peer?: string | null; retryMaxAgeMs?: number; settleMs?: number } = {}): Rig {
  const clock = { t: T0 };
  const cb = new FakeClipboard(o.cb);
  const r = { cb, clock, pushed: [] as ClipPushArgs[], images: [] as Buffer[], enabled: { v: true }, fail: { n: 0, result: "applied" as const }, logs: [] as string[] } as Rig;
  const d: ClipDeps = {
    backend: cb, now: () => clock.t, sleep: async () => {}, settleMs: o.settleMs ?? 0, isEnabled: () => r.enabled.v, log: (m) => r.logs.push(m),
    rank: o.rank ?? 0, peer: o.peer === undefined ? "karşı" : o.peer, retryMaxAgeMs: o.retryMaxAgeMs,
    send: {
      pushText: async (a) => { if (r.fail.n > 0) { r.fail.n--; throw new Error("ağ yok"); } r.pushed.push(a); return r.fail.result; },
      pushImage: async (p) => { r.images.push(p); return "applied"; },
    },
  };
  r.sync = new ClipSync(d); live.push(r.sync);
  return r;
}
const adv = (r: Rig, ms = 10) => { r.clock.t += ms; };

describe("aktarim:B semanticHash", () => {
  it("metinde CRLF/CR/LF aynı özet; farklı metin farklı; resim ayrı alan adı", () => {
    expect(semanticHash(text("a\r\nb"))).toBe(semanticHash(text("a\nb")));
    expect(semanticHash(text("a\rb"))).toBe(semanticHash(text("a\nb")));
    expect(semanticHash(text("a\nb"))).not.toBe(semanticHash(text("a\nc")));
    expect(semanticHash({ kind: "image", bytes: Buffer.from("a") })).not.toBe(semanticHash(text("a")));
  });
});

describe("aktarim:B ClipSync.tick", () => {
  it("kurulumdaki içerik taban çizgisidir (gönderilmez); sonraki yerel kopya gider", async () => {
    const r = rig(); r.cb.setLocal(text("eski")); // aynı anda: taban
    await r.sync.tick(); expect(r.pushed).toEqual([]);
    adv(r); r.cb.setLocal(text("yeni")); adv(r); await r.sync.tick();
    expect(r.pushed).toHaveLength(1);
    expect(Buffer.from(r.pushed[0]!.data, "base64").toString()).toBe("yeni");
    expect(r.pushed[0]).toMatchObject({ kind: "text", rank: 0 });
  });
  it("kuruluştan önce var olan ve ilk yoklamada görülen içerik de taban (changeCount okunamayınca)", async () => {
    const cb = new FakeClipboard(); cb.setLocal(text("var"));
    const pushed: ClipPushArgs[] = [];
    const s = new ClipSync({ backend: cb, now: () => T0, isEnabled: () => true, log: () => {}, rank: 0, peer: null, send: { pushText: async (a) => { pushed.push(a); return "applied"; }, pushImage: async () => "applied" } });
    await s.tick(); expect(pushed).toEqual([]);
  });
  it("sakin pano: tekrarlı yoklama hiçbir şey göndermez ve içerik okumaz", async () => {
    const r = rig(); await r.sync.tick(); const reads = r.cb.reads;
    for (let i = 0; i < 30; i++) { adv(r); await r.sync.tick(); }
    expect(r.pushed).toEqual([]); expect(r.cb.reads).toBe(reads);
  });
  it("kapalıyken kopyalanan, açılınca gönderilmez; sonraki kopya gider", async () => {
    const r = rig(); await r.sync.tick();
    r.enabled.v = false; adv(r); r.cb.setLocal(text("gizli")); adv(r); await r.sync.tick();
    r.enabled.v = true; adv(r); await r.sync.tick();
    expect(r.pushed).toEqual([]);
    adv(r); r.cb.setLocal(text("açık")); adv(r); await r.sync.tick();
    expect(r.pushed).toHaveLength(1);
  });
  it("karşı makine yoksa (peer null) göndermez", async () => {
    const r = rig({ peer: null }); await r.sync.tick();
    adv(r); r.cb.setLocal(text("x")); adv(r); await r.sync.tick();
    expect(r.pushed).toEqual([]);
  });
  it("gönderim hatasında bekleyen değer yeniden denenir; 'applied' sonrası bir daha gönderilmez", async () => {
    const r = rig(); await r.sync.tick(); r.fail.n = 2;
    adv(r); r.cb.setLocal(text("v")); adv(r); await r.sync.tick();
    expect(r.pushed).toEqual([]);
    adv(r, 1500); await r.sync.tick(); expect(r.pushed).toEqual([]); // geri çekilme (2 sn) dolmadı: deneme yok, n hâlâ 1
    expect(r.fail.n).toBe(1);
    adv(r, 1000); await r.sync.tick(); expect(r.fail.n).toBe(0); expect(r.pushed).toEqual([]); // ikinci hata
    adv(r, 5000); await r.sync.tick(); expect(r.pushed).toHaveLength(1);
    adv(r, 5000); await r.sync.tick(); expect(r.pushed).toHaveLength(1);
    expect(r.logs.some((l) => l.includes("ağ yok"))).toBe(true);
  });
  it("bekleyen değer 10 dk (retryMaxAgeMs) sonra atılır: uyku/uyanma sonrası eski değer gitmez", async () => {
    const r = rig(); await r.sync.tick(); r.fail.n = 1;
    adv(r); r.cb.setLocal(text("eski")); adv(r); await r.sync.tick();
    adv(r, 10 * 60_000 + 1); await r.sync.tick();
    expect(r.pushed).toEqual([]);
  });
  it("özel retryMaxAgeMs uygulanır; daha yeni kopya bekleyeni değiştirir", async () => {
    const r = rig({ retryMaxAgeMs: 1000 }); await r.sync.tick(); r.fail.n = 1;
    adv(r); r.cb.setLocal(text("a")); adv(r); await r.sync.tick();
    adv(r, 20); r.cb.setLocal(text("b")); adv(r, 2000); await r.sync.tick();
    expect(r.pushed.map((p) => Buffer.from(p.data, "base64").toString())).toEqual(["b"]);
  });
  it("karşı 'disabled' ya da 'stale' derse bekleyen atılır (tekrar denenmez)", async () => {
    const r = rig(); await r.sync.tick(); r.fail.result = "disabled";
    adv(r); r.cb.setLocal(text("a")); adv(r); await r.sync.tick();
    adv(r, 60_000); await r.sync.tick(); adv(r, 60_000); await r.sync.tick();
    expect(r.pushed).toHaveLength(1);
  });
  it("sınırlar: 1 MiB gider, 1 MiB+1 gitmez; resim 20 MiB gider, +1 gitmez; geçersiz UTF-8 gitmez", async () => {
    const r = rig(); await r.sync.tick();
    for (const [c, ok] of [[text("a".repeat(CLIP_MAX_TEXT_BYTES)), true], [text("a".repeat(CLIP_MAX_TEXT_BYTES + 1)), false], [{ kind: "text" as const, bytes: Buffer.from([0xff, 0xfe, 0x80]) }, false]] as const) {
      const before = r.pushed.length; adv(r); r.cb.setLocal(c); adv(r); await r.sync.tick();
      expect(r.pushed.length - before, `${c.bytes.length}`).toBe(ok ? 1 : 0);
    }
    const big = Buffer.concat([pngBytes(), Buffer.alloc(CLIP_MAX_IMAGE_BYTES - 33)]);
    adv(r); r.cb.setLocal({ kind: "image", bytes: big }); adv(r); await r.sync.tick(); expect(r.images).toHaveLength(1);
    adv(r); r.cb.setLocal({ kind: "image", bytes: Buffer.concat([big, Buffer.alloc(1)]) }); adv(r); await r.sync.tick(); expect(r.images).toHaveLength(1);
  });
  it("okunamayan içerik (CF_HDROP: read null) gönderilmez ama eski uzak değerin üstüne yazılmasını da engeller", async () => {
    const r = rig(); await r.sync.tick();
    adv(r); r.cb.setLocal(null); adv(r); await r.sync.tick();
    expect(r.pushed).toEqual([]);
    const old = T0 + 5; // yerel olaydan (T0+20) eski
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("eski"), key: [old, 1, 1], from: "karşı" })).toBe("stale");
  });
  it("saat geri giderse yerel olay yine de son uygulanan uzak değerden sonra sıralanır (Lamport)", async () => {
    const r = rig();
    await r.sync.tick();
    adv(r, 1000);
    const remoteTs = r.clock.t + 50_000; // karşının saati ileride
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("uzak"), key: [remoteTs, 1, 1], from: "karşı" })).toBe("applied");
    r.cb.setLocal(text("yerel")); adv(r, 10); await r.sync.tick();
    expect(r.pushed[0]!.eventTs).toBeGreaterThan(remoteTs);
  });
});

describe("aktarim:B ClipSync.applyRemote", () => {
  it("sıralama: daha yeni anahtar uygulanır, eşit ya da eski stale; eşit zamanda beyin (rank 1) kazanır", async () => {
    const r = rig(); const k = r.clock.t + 10;
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("b"), key: [k, 1, 1], from: "x" })).toBe("applied");
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("w"), key: [k, 0, 99], from: "x" })).toBe("stale");
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("aynı"), key: [k, 1, 1], from: "x" })).toBe("stale");
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("sayaç"), key: [k, 1, 2], from: "x" })).toBe("applied");
    expect(r.cb.writes.map((w) => w.bytes.toString())).toEqual(["b", "sayaç"]);
  });
  it("kapalıyken 'disabled'; 1 MiB+1 'too_large'; bozuk UTF-8 bad_request; resim sınırı ve bozuk PNG", async () => {
    const r = rig(); const k = () => [r.clock.t += 10, 1, 1] as const;
    r.enabled.v = false; expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("x"), key: k(), from: "x" })).toBe("disabled"); r.enabled.v = true;
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.alloc(CLIP_MAX_TEXT_BYTES + 1, 0x61), key: k(), from: "x" })).toBe("too_large");
    await expect(r.sync.applyRemote({ kind: "text", bytes: Buffer.from([0xff, 0xfe]), key: k(), from: "x" })).rejects.toMatchObject({ code: "bad_request" });
    expect(await r.sync.applyRemote({ kind: "image", bytes: Buffer.alloc(CLIP_MAX_IMAGE_BYTES + 1), key: k(), from: "x" })).toBe("too_large");
    expect(await r.sync.applyRemote({ kind: "image", bytes: Buffer.from("png değil"), key: k(), from: "x" })).toBe("bad_image");
    expect(await r.sync.applyRemote({ kind: "image", bytes: pngBytes(20_000, 20_000), key: k(), from: "x" })).toBe("bad_image");
    expect(await r.sync.applyRemote({ kind: "image", bytes: pngBytes(), key: k(), from: "x" })).toBe("applied");
    expect(r.cb.writes).toHaveLength(1);
  });
  it("okuma ile yazma arasında kullanıcı kopyalarsa 'local_changed', yazma olmaz; sonraki yoklama yerel değeri yollar", async () => {
    const r = rig(); await r.sync.tick();
    const orig = r.cb.read.bind(r.cb);
    r.cb.read = async () => { const x = await orig(); r.cb.setLocal(text("kullanıcı")); return x; }; // anlık görüntüden hemen sonra kopyalar
    adv(r);
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("uzak"), key: [r.clock.t + 1, 1, 1], from: "x" })).toBe("local_changed");
    expect(r.cb.writes).toEqual([]);
    r.cb.read = orig; adv(r, 20); await r.sync.tick();
    expect(Buffer.from(r.pushed[0]!.data, "base64").toString()).toBe("kullanıcı");
  });
  it("yoklamanın görmediği yerel kopya uzak yazmadan önce işlenir: yerel anahtar büyükse uzak 'stale', yerel kopya ezilmez ve gönderilir", async () => {
    const r = rig(); await r.sync.tick();
    adv(r); r.cb.setLocal(text("görülmemiş yerel"));
    adv(r); const remoteKey: [number, 0 | 1, number] = [r.clock.t - 5, 1, 1]; // yerel olaydan daha eski uzak olay
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("uzak"), key: remoteKey, from: "x" })).toBe("stale");
    expect(r.cb.writes).toEqual([]);
    adv(r, 20); await r.sync.tick();
    expect(Buffer.from(r.pushed[0]!.data, "base64").toString()).toBe("görülmemiş yerel");
  });
  it("görülmemiş yerel kopyadan SONRAKİ uzak olay uygulanır; yerel kopya da (eski anahtarla) gönderim için kuyruğa alınmıştı ama ezilince atılır", async () => {
    const r = rig(); await r.sync.tick();
    adv(r); r.cb.setLocal(text("görülmemiş yerel"));
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("uzak"), key: [r.clock.t + 50, 1, 1], from: "x" })).toBe("applied");
    adv(r, 100); await r.sync.tick();
    expect(r.pushed).toEqual([]);
  });
  it("yazma yarışı: backend 'written:false' dönerse 'local_changed'", async () => {
    const r = rig(); vi.spyOn(r.cb, "write").mockResolvedValueOnce({ written: false, seqAfter: 99, reason: "local_changed" });
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("x"), key: [r.clock.t + 1, 1, 1], from: "x" })).toBe("local_changed");
  });
  it("uzak yazma bekleyen (gönderilemeyen) eski yerel değeri geçersiz kılar", async () => {
    const r = rig(); await r.sync.tick(); r.fail.n = 1;
    adv(r); r.cb.setLocal(text("yerel")); adv(r); await r.sync.tick();
    adv(r, 5); expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("uzak"), key: [r.clock.t, 1, 1], from: "x" })).toBe("applied");
    adv(r, 10_000); await r.sync.tick();
    expect(r.pushed).toEqual([]);
  });
  it("ayar süresi: settleMs>0 ise bekler ve seqAfter'ı durulana dek yeniden okur (gecikmeli artış yankı sayılmaz)", async () => {
    const r = rig({ cb: { bumpPerWrite: 2 }, settleMs: 150 }); await r.sync.tick();
    const sleeps: number[] = []; (r.sync as unknown as { d: ClipDeps }).d.sleep = async (ms) => { sleeps.push(ms); };
    await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("x"), key: [r.clock.t + 1, 1, 1], from: "x" });
    expect(sleeps.length).toBeGreaterThanOrEqual(1); expect(sleeps[0]).toBe(150);
    adv(r, 10); await r.sync.tick(); expect(r.pushed).toEqual([]);
  });
});

describe("aktarim:B yerleşme penceresi", () => {
  it("pencerede farklı içerik gelirse (üçüncü taraf/kullanıcı) yankı sayılmaz, yerel olay olarak gönderilir", async () => {
    const r = rig({ settleMs: 150 }); await r.sync.tick();
    let n = 0; (r.sync as unknown as { d: ClipDeps }).d.sleep = async () => { if (n++ === 0) r.cb.setLocal(text("kullanıcı kopyası")); };
    expect(await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("uzak"), key: [r.clock.t + 1, 1, 1], from: "x" })).toBe("applied");
    adv(r, 20); await r.sync.tick();
    expect(r.pushed.map((p) => Buffer.from(p.data, "base64").toString())).toEqual(["kullanıcı kopyası"]);
  });
  it("pencerede aynı içeriğin yeniden yazılması (CRLF dönüşümü dahil) yankıdır, gönderilmez", async () => {
    const r = rig({ settleMs: 150 }); await r.sync.tick();
    let n = 0; (r.sync as unknown as { d: ClipDeps }).d.sleep = async () => { if (n++ === 0) r.cb.setLocal(text("a\r\nb")); };
    await r.sync.applyRemote({ kind: "text", bytes: Buffer.from("a\nb"), key: [r.clock.t + 1, 1, 1], from: "x" });
    adv(r, 20); await r.sync.tick(); expect(r.pushed).toEqual([]);
  });
});

describe("aktarim:B gizli kopyalar", () => {
  it("backend hidden:true derse (parola yöneticisi) gönderilmez; yalnız sayaç ilerler; sonraki normal kopya gider", async () => {
    const r = rig(); await r.sync.tick();
    const orig = r.cb.read.bind(r.cb); r.cb.read = async () => ({ ...(await orig()), hidden: true });
    adv(r); r.cb.setLocal(text("parola")); adv(r); await r.sync.tick();
    expect(r.pushed).toEqual([]);
    r.cb.read = orig; adv(r); r.cb.setLocal(text("normal")); adv(r); await r.sync.tick();
    expect(r.pushed.map((p) => Buffer.from(p.data, "base64").toString())).toEqual(["normal"]);
  });
  it("günlükte içerik özeti yok, yalnız bayt sayısı", async () => {
    const r = rig(); await r.sync.tick(); adv(r); r.cb.setLocal(text("gizli metin")); adv(r); await r.sync.tick();
    const line = r.logs.find((l) => l.includes("gönderildi"))!; expect(line).toMatch(/11 bayt/); expect(line).not.toMatch(/[0-9a-f]{8}/);
  });
});

describe("aktarim:B yankı: 100+ tur", () => {
  it("bumpPerWrite:2 + CRLF dönüşümlü iki uç: gönderim sayısı yalnız gerçek yerel olay sayısı kadar", async () => {
    const crlf = (c: ClipContent) => (c.kind === "text" ? text(c.bytes.toString().replace(/\n/g, "\r\n")) : c);
    const a = rig({ cb: { bumpPerWrite: 2, transformOnWrite: crlf }, rank: 0 }), b = rig({ cb: { bumpPerWrite: 2, transformOnWrite: crlf }, rank: 1 });
    const clock = a.clock; (b.sync as unknown as { d: ClipDeps }).d.now = () => clock.t; (a.sync as unknown as { d: ClipDeps }).d.now = () => clock.t;
    let na = 0, nb = 0;
    (a.sync as unknown as { d: ClipDeps }).d.send.pushText = async (p) => { na++; return (await b.sync.applyRemote({ kind: "text", bytes: Buffer.from(p.data, "base64"), key: [p.eventTs, p.rank, p.counter], from: "a" })) === "applied" ? "applied" : "stale"; };
    (b.sync as unknown as { d: ClipDeps }).d.send.pushText = async (p) => { nb++; return (await a.sync.applyRemote({ kind: "text", bytes: Buffer.from(p.data, "base64"), key: [p.eventTs, p.rank, p.counter], from: "b" })) === "applied" ? "applied" : "stale"; };
    let genuine = 0;
    for (let i = 0; i < 150; i++) {
      const [s, o] = i % 2 ? [b, a] : [a, b];
      clock.t += 10; s.cb.setLocal(text(`değer ${i}\nikinci`)); genuine++; clock.t += 10;
      await s.sync.tick(); clock.t += 10; await o.sync.tick(); clock.t += 10; await s.sync.tick(); await o.sync.tick();
    }
    expect(na + nb).toBe(genuine);
    expect(a.cb.writes.length).toBe(nb); expect(b.cb.writes.length).toBe(na);
  });
});

describe("aktarim:B start/stop", () => {
  it("start CLIP_POLL_MS aralıkla yoklar, çift start tek zamanlayıcı; stop durdurur", async () => {
    vi.useFakeTimers();
    const r = rig(); const spy = vi.spyOn(r.sync, "tick");
    r.sync.start(); r.sync.start();
    await vi.advanceTimersByTimeAsync(CLIP_POLL_MS * 3 + 5);
    expect(spy).toHaveBeenCalledTimes(3);
    await r.sync.stop(); spy.mockClear();
    await vi.advanceTimersByTimeAsync(CLIP_POLL_MS * 3);
    expect(spy).not.toHaveBeenCalled();
  });
  it("yoklama hatası döngüyü öldürmez ve günlüğe düşer", async () => {
    vi.useFakeTimers();
    const r = rig(); await r.sync.tick();
    const spy = vi.spyOn(r.cb, "changeCount").mockRejectedValueOnce(new Error("yardımcı öldü"));
    r.sync.start(); await vi.advanceTimersByTimeAsync(CLIP_POLL_MS * 2 + 5);
    expect(r.logs.some((l) => l.includes("yardımcı öldü"))).toBe(true);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
