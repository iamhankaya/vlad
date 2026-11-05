import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runClip } from "../../src/clip/cli.js";
import { readClipState, writeClipState } from "../../src/clip/state.js";
import { agentDir } from "../../src/agent/state.js";
import { rmTemp } from "../helpers.js";
import { FakeClipboard } from "./harness.js";

// aktarim:B vlad clip on|off|status|get|set ve clip.json kalıcılığı. VLAD_HOME temp; gerçek pano yok (FakeClipboard enjekte).
let home: string, prev: string | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "vlad-akt-b-")); prev = process.env.VLAD_HOME; process.env.VLAD_HOME = home; });
afterEach(() => { if (prev === undefined) delete process.env.VLAD_HOME; else process.env.VLAD_HOME = prev; rmTemp(home); });

const io = (o: { backend?: FakeClipboard; alive?: boolean; stdin?: string } = {}) => {
  const out: string[] = []; const backend = o.backend ?? new FakeClipboard(); let closed = 0; backend.close = async () => { closed++; };
  return { out, backend, closed: () => closed, io: { backend, write: (s: string) => out.push(s), probe: async () => ({ alive: o.alive ?? false }), stdin: async () => Buffer.from(o.stdin ?? "") } };
};
const png = (): Buffer => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(2, 16); b.writeUInt32BE(2, 20); return b; };

describe("aktarim:B clip.json", () => {
  it("dosya yokken enabled:true; yazma kalıcı, sahibine özel ve .vlad-agent altında", () => {
    expect(readClipState()).toEqual({ enabled: true });
    writeClipState({ enabled: false });
    expect(readClipState()).toEqual({ enabled: false });
    const f = join(agentDir(), "clip.json");
    expect(existsSync(f)).toBe(true);
    if (process.platform !== "win32") expect(statSync(f).mode & 0o077).toBe(0);
    writeClipState({ enabled: true });
    expect(readClipState()).toEqual({ enabled: true });
  });
  it("bozuk dosya hata verir (sessizce 'açık' sayılmaz)", () => {
    writeClipState({ enabled: true });
    writeFileSync(join(agentDir(), "clip.json"), "{bozuk");
    expect(() => readClipState()).toThrow(/clip\.json/);
  });
});

describe("aktarim:B vlad clip komutları", () => {
  it("off/on kalıcı ve --json çıktısı; status enabled + agentRunning", async () => {
    const a = io(); await runClip("off", { json: true }, a.io);
    expect(JSON.parse(a.out.join(""))).toEqual({ enabled: false });
    const b = io({ alive: true }); await runClip("status", { json: true }, b.io);
    expect(JSON.parse(b.out.join(""))).toEqual({ enabled: false, agentRunning: true });
    const c = io(); await runClip("on", {}, c.io);
    expect(c.out.join("")).toMatch(/açık/);
    expect(readClipState().enabled).toBe(true);
    const d = io(); await runClip("status", {}, d.io);
    expect(d.out.join("")).toMatch(/açık.*Agent çalışmıyor|Agent çalışmıyor.*açık/s);
  });
  it("status: Agent yoklaması hata verirse agentRunning false", async () => {
    const a = io(); a.io.probe = async () => { throw new Error("kimlik belirsiz"); };
    await runClip("status", { json: true }, a.io);
    expect(JSON.parse(a.out.join(""))).toMatchObject({ agentRunning: false });
  });
  it("get: metin stdout'a ham yazılır; --json; boş pano hata; backend kapatılır", async () => {
    const a = io(); a.backend.setLocal({ kind: "text", bytes: Buffer.from("merhaba ğ\r\nx") });
    await runClip("get", {}, a.io); expect(a.out.join("")).toBe("merhaba ğ\r\nx"); expect(a.closed()).toBe(0); // enjekte backend'i CLI kapatmaz
    const j = io(); j.backend.setLocal({ kind: "text", bytes: Buffer.from("x") });
    await runClip("get", { json: true }, j.io); expect(JSON.parse(j.out.join(""))).toEqual({ kind: "text", text: "x" });
    await expect(runClip("get", {}, io().io)).rejects.toThrow(/boş/);
  });
  it("get: resimde --out gerekir; verilirse PNG baytları birebir dosyaya yazılır", async () => {
    const a = io(); a.backend.setLocal({ kind: "image", bytes: png() });
    await expect(runClip("get", {}, a.io)).rejects.toThrow(/--out/);
    const f = join(home, "o.png"); await runClip("get", { out: f }, a.io);
    expect(readFileSync(f).equals(png())).toBe(true);
  });
  it("set: metin argümanı, --file, --file - (stdin), --image; yazma expectSeq ile", async () => {
    const a = io(); await runClip("set", { text: "bir" }, a.io);
    const f = join(home, "m.txt"); writeFileSync(f, "iki\n"); await runClip("set", { file: f }, a.io);
    const s = io({ stdin: "üç" }); await runClip("set", { file: "-" }, s.io);
    expect(a.backend.writes.map((w) => w.bytes.toString())).toEqual(["bir", "iki\n"]);
    expect(s.backend.writes[0]!.bytes.toString()).toBe("üç");
    const p = join(home, "i.png"); writeFileSync(p, png()); await runClip("set", { image: p }, a.io);
    expect(a.backend.writes[2]).toMatchObject({ kind: "image" });
  });
  it("set: kaynak yok/çok, bozuk PNG, büyük metin, geçersiz UTF-8 ve yazma yarışı hata verir", async () => {
    const a = io();
    await expect(runClip("set", {}, a.io)).rejects.toThrow(/metin|--file|--image/);
    await expect(runClip("set", { text: "x", file: "-" }, a.io)).rejects.toThrow(/yalnız biri|birini/);
    const bad = join(home, "b.png"); writeFileSync(bad, "png değil");
    await expect(runClip("set", { image: bad }, a.io)).rejects.toThrow(/PNG/);
    await expect(runClip("set", { text: "a".repeat(1024 * 1024 + 1) }, a.io)).rejects.toThrow(/1 MiB/);
    const inv = io({ stdin: "" }); inv.io.stdin = async () => Buffer.from([0xff, 0xfe]);
    await expect(runClip("set", { file: "-" }, inv.io)).rejects.toThrow(/UTF-8/);
    const race = io(); race.backend.write = async () => ({ written: false, seqAfter: 9, reason: "local_changed" as const });
    await expect(runClip("set", { text: "x" }, race.io)).rejects.toThrow(/değişti/);
    expect(a.backend.writes).toEqual([]);
  });
});
