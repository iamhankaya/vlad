import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FrameDecoder, encodeFrame } from "../../src/agent/frame.js";
import { XFER_CHUNK_BYTES, type XferBeginResult, type XferCommitResult } from "../../src/transfer/types.js";
import { makeFile, startAktarimPair, type AktarimPair } from "./harness.js";
import { newId, sha } from "./a1-recv-helpers.js";

let pairs: AktarimPair[] = [];
const pair = async (...a: Parameters<typeof startAktarimPair>) => { const p = await startAktarimPair(...a); pairs.push(p); return p; };
afterEach(async () => { for (const p of pairs.splice(0)) await p.stop(); });

describe("A1 uçtan uca: imzalı Agent üzerinden alıcı (gönderici A2'de; ham op çağrıları)", () => {
  it("mac → windows: çok parçalı dosya teslimi, bildirim, günlükte parça verisi yok", async () => {
    const p = await pair();
    const src = makeFile(p.mac.stateDir, "src.bin", XFER_CHUNK_BYTES * 2 + 17, 5);
    const data = readFileSync(src), id = newId();
    const t = p.mac.transport;
    const b = (await t.call<XferBeginResult>("windows", "xfer-begin", { id, purpose: "file", entries: [{ path: "src.bin", kind: "file", size: data.length }] })).result;
    expect(b.state).toBe("new");
    for (let o = 0; o < data.length; o += b.chunkBytes) await t.call("windows", "xfer-chunk", { id, entry: 0, offset: o, data: data.subarray(o, o + b.chunkBytes).toString("base64") }, { timeoutMs: 60_000 });
    const c = (await t.call<XferCommitResult>("windows", "xfer-commit", { id, sha256: [sha(data)] })).result;
    expect(c.items[0]!.path).toBe(join(p.windows.downloads, "src.bin"));
    expect(readFileSync(c.items[0]!.path).equals(data)).toBe(true);
    expect(p.windows.notifier.calls).toEqual([{ title: "mac'den dosya geldi", body: "src.bin" }]);
    expect(readdirSync(join(p.windows.downloads, ".vlad-incoming"))).toEqual([]);
    const j = join(p.windows.stateDir, "journal.jsonl"); // UNJOURNALED: parça verisi günlüğe girmez
    expect(existsSync(j) ? readFileSync(j, "utf8") : "").not.toContain("xfer-");
  }, 30_000);

  it("windows → mac (iki yön)", async () => {
    const p = await pair(); const id = newId(); const d = Buffer.from("ters yön");
    await p.windows.transport.call("mac", "xfer-begin", { id, purpose: "file", entries: [{ path: "x.txt", kind: "file", size: d.length }] });
    await p.windows.transport.call("mac", "xfer-chunk", { id, entry: 0, offset: 0, data: d.toString("base64") });
    const c = (await p.windows.transport.call<XferCommitResult>("mac", "xfer-commit", { id, sha256: [sha(d)] })).result;
    expect(readFileSync(join(p.mac.downloads, "x.txt"))).toEqual(d);
    expect(c.items).toHaveLength(1);
  });

  it("commit yanıtı kaybolur: yeni imzalı istekle tekrar → aynı sonuç, çift teslim yok", async () => {
    const p = await pair(); const px = await p.viaProxy("mac"); const id = newId(); const d = Buffer.from("yanıt kaybı");
    const t = p.mac.transport;
    await t.call("windows", "xfer-begin", { id, purpose: "file", entries: [{ path: "k.txt", kind: "file", size: d.length }] });
    await t.call("windows", "xfer-chunk", { id, entry: 0, offset: 0, data: d.toString("base64") });
    px.dropResponse(1);
    await expect(t.call("windows", "xfer-commit", { id, sha256: [sha(d)] }, { timeoutMs: 2000 })).rejects.toBeTruthy();
    const c = (await t.call<XferCommitResult>("windows", "xfer-commit", { id, sha256: [sha(d)] })).result;
    expect(c.items[0]!.name).toBe("k.txt");
    expect(readdirSync(p.windows.downloads).sort()).toEqual([".vlad-incoming", "k.txt"]);
    expect(p.windows.notifier.calls).toHaveLength(1);
  });

  it("alıcı Agent yeniden başlar (bellek kaybı): yarım aktarım not_found, aynı id ile yeniden begin tam teslim eder", async () => {
    const p = await pair(); const id = newId(); const d = Buffer.from("yeniden başlama");
    const e = [{ path: "r.txt", kind: "file", size: d.length }];
    await p.mac.transport.call("windows", "xfer-begin", { id, purpose: "file", entries: e });
    await p.mac.transport.call("windows", "xfer-chunk", { id, entry: 0, offset: 0, data: d.subarray(0, 4).toString("base64") });
    await p.restartAgent("windows");
    await expect(p.mac.transport.call("windows", "xfer-chunk", { id, entry: 0, offset: 4, data: d.subarray(4).toString("base64") })).rejects.toMatchObject({ code: "not_found" });
    expect((await p.mac.transport.call<XferBeginResult>("windows", "xfer-begin", { id, purpose: "file", entries: e })).result.state).toBe("new");
    await p.mac.transport.call("windows", "xfer-chunk", { id, entry: 0, offset: 0, data: d.toString("base64") });
    await p.mac.transport.call("windows", "xfer-commit", { id, sha256: [sha(d)] });
    expect(readFileSync(join(p.windows.downloads, "r.txt"))).toEqual(d);
  });

  it("yol gezmesi denemesi ağdan da reddedilir; İndirilenler dışına yazılmaz", async () => {
    const p = await pair();
    await expect(p.mac.transport.call("windows", "xfer-begin", { id: newId(), purpose: "file", entries: [{ path: "../../evil.txt", kind: "file", size: 1 }] })).rejects.toMatchObject({ code: "bad_request" });
    expect(readdirSync(join(p.windows.downloads, ".."))).not.toContain("evil.txt");
  });
});

describe("A1.8 FrameDecoder ölçümü (eşikli test yok; sonuç rapora)", () => {
  it("4 MiB'lık çerçeve 64 KiB parçalarla çözülür", () => {
    const frame = encodeFrame({ a: "x".repeat(4 * 1024 * 1024) });
    const dec = new FrameDecoder();
    const t0 = process.hrtime.bigint();
    let out: unknown[] = [];
    for (let o = 0; o < frame.length; o += 65536) out = out.concat(dec.push(frame.subarray(o, o + 65536)));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(out).toHaveLength(1);
    console.log(`FrameDecoder 4 MiB / 64 KiB parça: ${ms.toFixed(1)} ms (${Math.ceil(frame.length / 65536)} parça)`);
  });
});
