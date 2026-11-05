import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/kb/config.js";
import type { VladConfig } from "../../src/kb/types.js";
import { exitCodeFor } from "../../src/machines/exit.js";
import { RemoteError, type AgentOp, type RemoteTransport } from "../../src/fleet/types.js";
import type { Notifier } from "../../src/platform/notify.js";
import { runSendCommand } from "../../src/transfer/cli.js";
import { canSymlink, rmTemp } from "../helpers.js";
import { makeFile } from "./harness.js";

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmTemp(t); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-a2c-")); temps.push(d); return d; };
const cfgOf = (...n: string[]): VladConfig => ({ ...defaultConfig(), brain: "mac", machines: n.map((name) => ({ name, os: name === "mac" ? "darwin" : "win32", agent: { host: "127.0.0.1", port: 1 } })) } as VladConfig);

/** Ağsız sahte karşı Agent: begin/chunk/commit'e kayıt tutarak yanıt verir. */
function fake(over: Partial<Record<AgentOp, (a: any) => unknown>> = {}) {
  const calls: { to: string; op: AgentOp; args: any }[] = [];
  const t: RemoteTransport = {
    async call(to, op, args: any) {
      calls.push({ to, op, args });
      const h = over[op];
      if (h) return { opId: "x", result: h(args) as never };
      const r = op === "ping" ? { caps: ["xfer", "clip"] }
        : op === "xfer-begin" ? { id: args.id, chunkBytes: 1024, state: "new" }
        : op === "xfer-chunk" ? { received: args.offset + Buffer.from(args.data, "base64").length }
        : { items: [] };
      return { opId: "x", result: r as never };
    },
  };
  return { t, calls };
}
const io = (o: { cfg?: VladConfig; t: RemoteTransport; notifier?: Notifier }) => {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { cfg: o.cfg ?? cfgOf("mac", "windows"), self: "mac", transport: o.t, notifier: o.notifier, write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s), sleep: async () => {} } };
};
const rec = () => { const calls: { title: string; body: string }[] = []; return { calls, n: { notify: async (title: string, body: string) => { calls.push({ title, body }); } } as Notifier }; };
const code = (e: unknown) => exitCodeFor(e);

describe("aktarim:A2 vlad send CLI", () => {
  it("--json: stdout yalnız tek JSON, anahtar kümesi sabit", async () => {
    const src = tmp(); const f = makeFile(src, "a.txt", 10, 1);
    const f2 = fake({ "xfer-commit": (a) => ({ items: [{ name: "a.txt", kind: "file", size: 10, path: "/D/a.txt" }] }) });
    const c = io({ t: f2.t });
    await runSendCommand([f], { json: true }, c.io);
    expect(c.out).toHaveLength(1); expect(c.out[0]!.endsWith("\n")).toBe(true);
    const j = JSON.parse(c.out[0]!);
    expect(Object.keys(j).sort()).toEqual(["items", "skipped", "to", "totalBytes"]);
    expect(j).toMatchObject({ to: "windows", totalBytes: 10, skipped: [] });
    expect(Object.keys(j.items[0]).sort()).toEqual(["kind", "name", "path", "size"]);
    expect(c.err).toEqual([]);
  });
  it("tek karşı makine varsa --to gerekmez; insan çıktısı stdout'a gider", async () => {
    const src = tmp(); const f = makeFile(src, "a.txt", 3, 1);
    const f2 = fake(); const c = io({ t: f2.t });
    await runSendCommand([f], {}, c.io);
    expect(f2.calls.every((x) => x.to === "windows")).toBe(true);
    expect(c.out.join("")).toMatch(/windows/);
  });
  it.skipIf(!canSymlink())("skipped dolu → başarı (hata fırlatmaz) ve insan çıktısı uyarır", async () => {
    const src = tmp(); makeFile(src, "d/a", 3, 1); symlinkSync(join(src, "d", "a"), join(src, "d", "l"));
    const c = io({ t: fake().t });
    await runSendCommand([join(src, "d")], { json: true }, c.io);
    expect(JSON.parse(c.out[0]!).skipped).toHaveLength(1);
  });
  it("--to bilinmiyor / kendine gönderme / 2+ makinede --to yok → hata (çıkış 1), ağa çıkılmaz", async () => {
    const src = tmp(); const f = makeFile(src, "a", 1, 1);
    const three = cfgOf("mac", "windows", "linux");
    for (const [o, cfg, re] of [[{ to: "olmayan" }, undefined, /olmayan/], [{ to: "mac" }, undefined, /mac/], [{}, three, /--to/]] as const) {
      const f2 = fake(); const c = io({ t: f2.t, cfg });
      const e = await runSendCommand([f], o, c.io).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(Error); expect(e.message).toMatch(re); expect(code(e)).toBe(1); expect(f2.calls).toEqual([]);
    }
  });
  it("olmayan yol → çıkış 1; ağa çıkılmaz", async () => {
    const f2 = fake(); const c = io({ t: f2.t });
    const e = await runSendCommand([join(tmp(), "yok")], {}, c.io).then(() => null, (x) => x);
    expect(code(e)).toBe(1); expect(f2.calls).toEqual([]);
  });
  it("çıkış tablosu: unreachable/timeout/busy/clock_skew → 75; forbidden → 1; eski Agent → 1; uncertain → 1", async () => {
    const src = tmp(); const f = makeFile(src, "a", 1, 1);
    const rows: [string, (a: any) => unknown, string, number][] = [
      ["ping", () => { throw new RemoteError("unreachable", "unreachable: x"); }, "unreachable", 75],
      ["ping", () => { throw new RemoteError("busy", "busy: x"); }, "busy", 75],
      ["ping", () => { throw new RemoteError("clock_skew", "clock_skew: x"); }, "clock_skew", 75],
      ["ping", () => { throw new RemoteError("forbidden", "forbidden: x"); }, "forbidden", 1],
      ["ping", () => ({}), "failed", 1],
      ["xfer-commit", () => { throw new RemoteError("timeout", "timeout: x"); }, "uncertain", 1],
    ];
    for (const [op, h, wantCode, exit] of rows) {
      const c = io({ t: fake({ [op]: h } as never).t });
      const e = await runSendCommand([f], { json: true }, c.io).then(() => null, (x) => x);
      expect(e.code, `${op}/${wantCode}`).toBe(wantCode); expect(code(e)).toBe(exit);
    }
  });
  it("kısmi teslim (failed dolu): JSON stdout'a yazılır, ardından hata → çıkış 1", async () => {
    const src = tmp(); const f = makeFile(src, "a", 1, 1);
    const c = io({ t: fake({ "xfer-commit": () => ({ items: [], failed: { name: "a", error: "disk dolu" } }) }).t });
    const e = await runSendCommand([f], { json: true }, c.io).then(() => null, (x) => x);
    expect(JSON.parse(c.out[0]!).failed).toEqual({ name: "a", error: "disk dolu" });
    expect(code(e)).toBe(1); expect(e.message).toMatch(/disk dolu/);
  });
  it("ilerleme yalnız TTY'de ve --json yokken stderr'e", async () => {
    const src = tmp(); const f = makeFile(src, "a.bin", 3000, 1);
    const run = async (o: { isTTY?: boolean; json?: boolean }) => { const c = io({ t: fake().t }); await runSendCommand([f], o, c.io); return c; };
    expect((await run({ isTTY: true })).err.join("")).toMatch(/%|3000/);
    expect((await run({ isTTY: false })).err).toEqual([]);
    expect((await run({ isTTY: true, json: true })).err).toEqual([]);
  });
  it("--notify: başarıda ve hatada bildirim; bildirici hata verirse yutulur", async () => {
    const src = tmp(); const f = makeFile(src, "a.txt", 1, 1);
    const ok = rec();
    await runSendCommand([f], { notify: true }, io({ t: fake({ "xfer-commit": () => ({ items: [{ name: "a.txt", kind: "file", size: 1, path: "/x" }] }) }).t, notifier: ok.n }).io);
    expect(ok.calls).toHaveLength(1); expect(ok.calls[0]!.title).toMatch(/windows/); expect(ok.calls[0]!.body).toMatch(/a\.txt/);
    const bad = rec();
    const e = await runSendCommand([f], { notify: true }, io({ t: fake({ ping: () => { throw new RemoteError("unreachable", "unreachable: kapalı"); } }).t, notifier: bad.n }).io).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(RemoteError); expect(bad.calls[0]!.body).toMatch(/gönderilemedi: .*kapalı/);
    const boom: Notifier = { notify: async () => { throw new Error("toast patladı"); } };
    await runSendCommand([f], { notify: true }, io({ t: fake().t, notifier: boom }).io);
  });
  it("uncertain hatasında bildirim 'gönderilemedi' DEMEZ (belirsiz)", async () => {
    const src = tmp(); const f = makeFile(src, "a", 1, 1); const r = rec();
    await runSendCommand([f], { notify: true }, io({ t: fake({ "xfer-commit": () => { throw new RemoteError("timeout", "timeout: x"); } }).t, notifier: r.n }).io).catch(() => {});
    expect(r.calls[0]!.body).toMatch(/belirsiz/); expect(r.calls[0]!.body).not.toMatch(/gönderilemedi/);
  });
  it("F-vlad-222: --notify ile hedef çözme hataları da bildirilir (genel başlık), hata yine fırlar", async () => {
    const src = tmp(); const f = makeFile(src, "a", 1, 1);
    const three = cfgOf("mac", "windows", "linux");
    for (const [o, cfg] of [[{ to: "olmayan" }, undefined], [{ to: "mac" }, undefined], [{}, three]] as const) {
      const f2 = fake(); const r = rec();
      const e = await runSendCommand([f], { ...o, notify: true }, io({ t: f2.t, cfg, notifier: r.n }).io).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(Error); expect(code(e)).toBe(1); expect(f2.calls).toEqual([]);
      expect(r.calls).toHaveLength(1); expect(r.calls[0]!.title).toBe("Gönderilemedi"); expect(r.calls[0]!.body).toMatch(/gönderilemedi: /);
    }
  });
  it("F-vlad-222: yapılandırma okunamazsa da bildirilir; --notify yoksa sessiz", async () => {
    const src = tmp(); const f = makeFile(src, "a", 1, 1); const r = rec();
    const bad = (n: Notifier) => ({ self: "mac", notifier: n, get cfg(): VladConfig { throw new Error("config bozuk"); } });
    const e = await runSendCommand([f], { notify: true }, bad(r.n)).then(() => null, (x) => x);
    expect(e.message).toMatch(/config bozuk/); expect(r.calls).toHaveLength(1); expect(r.calls[0]!.title).toBe("Gönderilemedi");
    const r2 = rec();
    await runSendCommand([f], {}, bad(r2.n)).catch(() => {});
    expect(r2.calls).toEqual([]);
  });
  it("F-vlad-221: sorunlu ad → ağa çıkmadan bad_request, bildirimde sorunlu yol", async () => {
    const src = tmp(); const f = makeFile(src, "a:b.txt", 1, 1); const r = rec(); const f2 = fake();
    const e = await runSendCommand([f], { notify: true }, io({ t: f2.t, notifier: r.n }).io).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(RemoteError); expect(e.code).toBe("bad_request"); expect(code(e)).toBe(1); expect(f2.calls).toEqual([]);
    expect(r.calls[0]!.body).toMatch(/a:b\.txt/);
  });
  it("--notify yok → bildirim yok", async () => {
    const src = tmp(); const f = makeFile(src, "a", 1, 1); const r = rec();
    await runSendCommand([f], {}, io({ t: fake().t, notifier: r.n }).io);
    expect(r.calls).toEqual([]);
  });
});
