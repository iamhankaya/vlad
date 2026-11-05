import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteError, type AgentOp, type RemoteTransport } from "../../src/fleet/types.js";
import { sendPaths, XferUncertainError } from "../../src/transfer/send.js";
import { XFER_STAGING_DIR } from "../../src/transfer/types.js";
import { rmTemp } from "../helpers.js";
import { makeFile, startAktarimPair, type AktarimPair } from "./harness.js";

const pairs: AktarimPair[] = [];
const temps: string[] = [];
afterEach(async () => { for (const p of pairs.splice(0)) await p.stop(); for (const t of temps.splice(0)) rmTemp(t); });
const setup = async (size = 2500) => {
  const p = await startAktarimPair(); pairs.push(p);
  const d = mkdtempSync(join(tmpdir(), "vlad-a2r-")); temps.push(d);
  return { p, file: makeFile(d, "x.bin", size, 1) };
};
type Hook = (op: AgentOp, args: any, n: number, real: () => ReturnType<RemoteTransport["call"]>) => Promise<any> | undefined;
/** op başına sayaçlı, davranışı değiştirilebilir sarmalayıcı */
const wrap = (t: RemoteTransport, hook: Hook) => {
  const log: { op: AgentOp; args: any }[] = []; const counts: Record<string, number> = {};
  const w: RemoteTransport = {
    call: (to, op, args, o) => {
      log.push({ op, args }); counts[op] = (counts[op] ?? 0) + 1;
      return (hook(op, args, counts[op]!, () => t.call(to, op, args, o)) ?? t.call(to, op, args, o)) as never;
    },
  };
  return { w, log, counts };
};
const sleeps = () => { const s: number[] = []; return { s, sleep: async (ms: number) => { s.push(ms); } }; };
const ids = (log: { op: AgentOp; args: any }[]) => new Set(log.filter((l) => l.op.startsWith("xfer-")).map((l) => l.args.id));

describe("aktarim:A2 dayanıklılık", () => {
  it("parça zaman aşımı → yeniden denenir (200 ms bekleme), teslim tamam", async () => {
    const { p, file } = await setup();
    const { w, counts } = wrap(p.mac.transport, (op, _a, n) => (op === "xfer-chunk" && n === 1 ? Promise.reject(new RemoteError("timeout", "timeout: x")) : undefined));
    const sl = sleeps();
    const r = await sendPaths(w, { to: "windows", paths: [file], chunkBytes: 1000, sleep: sl.sleep });
    expect(r.items).toHaveLength(1); expect(sl.s).toEqual([200]); expect(counts["xfer-chunk"]).toBe(4);
  });
  it("parça 3 denemede de zaman aşımı → geçici hata (75), bekleme 200/800", async () => {
    const { p, file } = await setup();
    const { w, counts } = wrap(p.mac.transport, (op) => (op === "xfer-chunk" ? Promise.reject(new RemoteError("timeout", "timeout: x")) : undefined));
    const sl = sleeps();
    const e = await sendPaths(w, { to: "windows", paths: [file], sleep: sl.sleep }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(RemoteError); expect(e.transient).toBe(true);
    expect(counts["xfer-chunk"]).toBe(3); expect(sl.s).toEqual([200, 800]);
  });
  it("kalıcı hata (bad_request) yeniden denenmez ve xfer-abort gider", async () => {
    const { p, file } = await setup();
    const { w, counts } = wrap(p.mac.transport, (op) => (op === "xfer-chunk" ? Promise.reject(new RemoteError("bad_request", "bad_request: x")) : undefined));
    const e = await sendPaths(w, { to: "windows", paths: [file], sleep: async () => {} }).then(() => null, (x) => x);
    expect(e.code).toBe("bad_request"); expect(counts["xfer-chunk"]).toBe(1); expect(counts["xfer-abort"]).toBe(1);
  });
  it("chunk not_found → AYNI id ile xfer-begin tekrarı, sonra baştan parçalar; yeni id yok", async () => {
    const { p, file } = await setup();
    const { w, log, counts } = wrap(p.mac.transport, (op, _a, n) => (op === "xfer-chunk" && n === 2 ? Promise.reject(new RemoteError("not_found", "not_found: aktarım bulunamadı")) : undefined));
    const r = await sendPaths(w, { to: "windows", paths: [file], chunkBytes: 1000, sleep: async () => {} });
    expect(r.items).toHaveLength(1); expect(counts["xfer-begin"]).toBe(2); expect(ids(log).size).toBe(1);
  });
  it("not_found sonrası begin 'committed' dönerse parça göndermeden sonucu verir", async () => {
    const { p, file } = await setup();
    const { w, counts } = wrap(p.mac.transport, (op, a, n, real) => {
      if (op === "xfer-chunk" && n === 2) return Promise.reject(new RemoteError("not_found", "not_found: x"));
      if (op === "xfer-begin" && n === 2) return real().then((r: any) => ({ ...r, result: { id: a.id, chunkBytes: 1000, state: "committed", items: [{ name: "x.bin", kind: "file", size: 2500, path: "/x" }] } }));
      return undefined;
    });
    const r = await sendPaths(w, { to: "windows", paths: [file], chunkBytes: 1000, sleep: async () => {} });
    expect(r.items.map((i) => i.name)).toEqual(["x.bin"]); expect(counts["xfer-chunk"]).toBe(2); expect(counts["xfer-commit"]).toBeUndefined();
  });
  it("not_found ikinci kez gelirse sonsuz döngü yok: hata fırlar", async () => {
    const { p, file } = await setup();
    const { w, counts } = wrap(p.mac.transport, (op) => (op === "xfer-chunk" ? Promise.reject(new RemoteError("not_found", "not_found: aktarım bulunamadı")) : undefined));
    const e = await sendPaths(w, { to: "windows", paths: [file], sleep: async () => {} }).then(() => null, (x) => x);
    expect(e.code).toBe("not_found"); expect(counts["xfer-begin"]).toBe(2);
  });
  it("commit yanıtı kayıp (istek işlendi): aynı commit tekrarlanır, çift teslim yok, aynı id", async () => {
    const { p, file } = await setup();
    const { w, log, counts } = wrap(p.mac.transport, (op, _a, n, real) => (op === "xfer-commit" && n === 1 ? real().then(() => { throw new RemoteError("timeout", "timeout: yanıt yok"); }) : undefined));
    const r = await sendPaths(w, { to: "windows", paths: [file], sleep: async () => {} });
    expect(r.items.map((i) => i.name)).toEqual(["x.bin"]); expect(counts["xfer-commit"]).toBe(2); expect(ids(log).size).toBe(1);
    expect(require("node:fs").readdirSync(p.windows.downloads).filter((n: string) => n !== XFER_STAGING_DIR)).toEqual(["x.bin"]);
  });
  it("commit hep zaman aşımı → XferUncertainError (code uncertain); yeni id ile baştan başlamaz", async () => {
    const { p, file } = await setup();
    const { w, log, counts } = wrap(p.mac.transport, (op) => (op === "xfer-commit" ? Promise.reject(new RemoteError("timeout", "timeout: yanıt yok")) : undefined));
    const e = await sendPaths(w, { to: "windows", paths: [file], sleep: async () => {} }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(XferUncertainError); expect(e.code).toBe("uncertain"); expect(e.transient).toBe(false);
    expect(counts["xfer-commit"]).toBe(3); expect(counts["xfer-begin"]).toBe(1); expect(ids(log).size).toBe(1);
  });
  it("commit hep unreachable (istek hiç gitmedi) → uncertain değil, geçici hata", async () => {
    const { p, file } = await setup();
    const { w } = wrap(p.mac.transport, (op) => (op === "xfer-commit" ? Promise.reject(new RemoteError("unreachable", "unreachable: x")) : undefined));
    const e = await sendPaths(w, { to: "windows", paths: [file], sleep: async () => {} }).then(() => null, (x) => x);
    expect(e).not.toBeInstanceOf(XferUncertainError); expect(e.code).toBe("unreachable"); expect(e.transient).toBe(true);
  });
  it("timeout sonrası unreachable da belirsizdir (ilk istek işlenmiş olabilir)", async () => {
    const { p, file } = await setup();
    const { w } = wrap(p.mac.transport, (op, _a, n) => (op === "xfer-commit" ? Promise.reject(new RemoteError(n === 1 ? "timeout" : "unreachable", "x")) : undefined));
    const e = await sendPaths(w, { to: "windows", paths: [file], sleep: async () => {} }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(XferUncertainError);
  });
  it("alıcı 'uncertain' derse XferUncertainError olarak çıkar, tekrar denenmez", async () => {
    const { p, file } = await setup();
    const { w, counts } = wrap(p.mac.transport, (op) => (op === "xfer-commit" ? Promise.reject(new RemoteError("uncertain", "uncertain: teslim sonucu belirsiz; İndirilenler'e bak")) : undefined));
    const e = await sendPaths(w, { to: "windows", paths: [file], sleep: async () => {} }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(XferUncertainError); expect(counts["xfer-commit"]).toBe(1);
  });
  it("belirsiz commit ve geçici hata sonrası xfer-abort GÖNDERİLMEZ (teslim edilmiş olabilir)", async () => {
    const { p, file } = await setup();
    const a = wrap(p.mac.transport, (op) => (op === "xfer-commit" ? Promise.reject(new RemoteError("timeout", "timeout: x")) : undefined));
    await sendPaths(a.w, { to: "windows", paths: [file], sleep: async () => {} }).catch(() => {});
    expect(a.counts["xfer-abort"]).toBeUndefined();
    const b = wrap(p.mac.transport, (op) => (op === "xfer-chunk" ? Promise.reject(new RemoteError("timeout", "timeout: x")) : undefined));
    await sendPaths(b.w, { to: "windows", paths: [file], sleep: async () => {} }).catch(() => {});
    expect(b.counts["xfer-abort"]).toBeUndefined();
  });
  it("gerçek yanıt kaybı (vekil dropResponse) sonrası uçtan uca: aynı id, tek teslim", async () => {
    const { p, file } = await setup(100);
    const px = await p.viaProxy("mac");
    // ping(1) begin(2) chunk(3) commit(4): commit yanıtı düşer; istemci zaman aşımını beklemesin diye bağlantı kesilir (sonuç belirsiz → timeout sınıfı)
    px.dropResponse(4);
    const r = await sendPaths(p.mac.transport, { to: "windows", paths: [file], sleep: async () => {} });
    expect(r.items).toHaveLength(1);
    expect(require("node:fs").readdirSync(p.windows.downloads).filter((n: string) => n !== XFER_STAGING_DIR)).toEqual(["x.bin"]);
  }, 30_000);
});
