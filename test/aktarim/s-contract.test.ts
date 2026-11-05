import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OP_TABLE, TRANSFER_OPS, allowedOps, buildOps, isAllowed } from "../../src/agent/ops/index.js";
import { CLIP_MAX_IMAGE_BYTES, CLIP_MAX_PIXELS, CLIP_MAX_TEXT_BYTES, CLIP_POLL_MS } from "../../src/clip/types.js";
import { createBackend } from "../../src/clip/backend.js";
import { MAX_FRAME_BYTES, type AgentOp } from "../../src/fleet/types.js";
import { NativeDisabledError, assertNative, nativeAllowed } from "../../src/platform/native.js";
import { createNotifier } from "../../src/platform/notify.js";
import {
  XFER_CHUNK_BYTES, XFER_ID_RE, XFER_IDLE_MS, XFER_MAX_ACTIVE, XFER_MAX_ENTRIES, XFER_MAX_INFLIGHT_CHUNKS, XFER_MAX_TOTAL_BYTES,
  XFER_MIN_FREE_BYTES, XFER_STAGING_DIR, XFER_STAGING_QUOTA_BYTES, XFER_STALE_MS,
} from "../../src/transfer/types.js";
import { rmTemp } from "../helpers.js";
import { FakeClipboard, FakeNotifier, makeFile, startAktarimPair, treeHash, type AktarimPair } from "./harness.js";

// aktarim:S — sözleşme: yalnız şekil/yüzey; iş mantığı yok, stub durumu test edilmez.

const NEW_OPS: AgentOp[] = ["xfer-begin", "xfer-chunk", "xfer-commit", "xfer-abort", "clip-push"];
const pairs: AktarimPair[] = [];
const temps: string[] = [];
afterEach(async () => { for (const p of pairs.splice(0)) await p.stop(); for (const t of temps.splice(0)) rmTemp(t); });
const pair = async (...a: Parameters<typeof startAktarimPair>) => { const p = await startAktarimPair(...a); pairs.push(p); return p; };

describe("aktarim:S sabitler", () => {
  it("plandaki değerler", () => {
    expect(XFER_CHUNK_BYTES).toBe(3 * 1024 * 1024);
    expect(XFER_CHUNK_BYTES * 4 / 3).toBeLessThanOrEqual(4 * 1024 * 1024); // base64: tam 4 MiB; imza/meta payıyla 8 MiB çerçevenin altında
    expect(XFER_CHUNK_BYTES * 4 / 3 + 64 * 1024).toBeLessThan(MAX_FRAME_BYTES);
    expect(XFER_MAX_TOTAL_BYTES).toBe(4 * 1024 ** 3);
    expect(XFER_MAX_ENTRIES).toBe(10_000);
    expect(XFER_MAX_ACTIVE).toBe(4);
    expect(XFER_MAX_INFLIGHT_CHUNKS).toBe(4);
    expect(XFER_STAGING_QUOTA_BYTES).toBe(8 * 1024 ** 3);
    expect(XFER_MIN_FREE_BYTES).toBe(1024 ** 3);
    expect(XFER_IDLE_MS).toBe(5 * 60_000);
    expect(XFER_STALE_MS).toBe(24 * 3600_000);
    expect(XFER_STAGING_DIR).toBe(".vlad-incoming");
    expect(CLIP_MAX_TEXT_BYTES).toBe(1024 * 1024);
    expect(CLIP_MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
    expect(CLIP_MAX_PIXELS).toBe(64_000_000);
    expect(CLIP_POLL_MS).toBe(500);
  });
  it("XFER_ID_RE: 32 küçük harf hex", () => {
    expect(XFER_ID_RE.test("0123456789abcdef0123456789abcdef")).toBe(true);
    for (const bad of ["", "../../x", ".", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0"]) expect(XFER_ID_RE.test(bad), bad).toBe(false);
  });
});

describe("aktarim:S op tablosu ve yetkiler", () => {
  it("TRANSFER_OPS tam olarak 5 yeni op; OP_TABLE hepsini içerir", () => {
    expect([...TRANSFER_OPS].sort()).toEqual([...NEW_OPS].sort());
    for (const op of NEW_OPS) expect(typeof OP_TABLE[op], op).toBe("function");
  });
  it("beyin↔işçi iki yönlü izinli; console ve self değil", () => {
    for (const op of NEW_OPS) {
      expect(isAllowed("worker-agent", "brain", op), `brain→worker ${op}`).toBe(true);
      expect(isAllowed("brain-agent", "worker", op), `worker→brain ${op}`).toBe(true);
      for (const c of ["console", "self", "worker"] as const) expect(isAllowed("worker-agent", c, op), `worker-agent ${c} ${op}`).toBe(false);
      for (const c of ["console", "self", "brain"] as const) expect(isAllowed("brain-agent", c, op), `brain-agent ${c} ${op}`).toBe(false);
    }
  });
  it("console'un mevcut yüzeyi değişmez", () => {
    expect([...allowedOps("brain-agent", "console")].sort()).toEqual(["exec", "kb-head", "ping"]);
  });
  it("buildOps her çağrıda bağımsız durum kurar ve mevcut op'ları korur", async () => {
    const p = await pair();
    const a = buildOps(depsOf(p)), b = buildOps(depsOf(p));
    for (const op of NEW_OPS) expect(a[op], op).not.toBe(b[op]);
    expect(a.launch).toBe(OP_TABLE.launch);
  });
});

/** harness'ın kurduğu bağımlılıklardan bağımsız, yalnız şekil için asgari AktarimDeps. */
function depsOf(p: AktarimPair) {
  const d = mkdtempSync(join(tmpdir(), "vlad-akt-s-")); temps.push(d);
  return {
    self: "mac", kind: "brain-agent" as const, cfg: () => ({}) as never, now: () => Date.now(), env: () => ({}) as never,
    xfer: { downloads: () => d, stateDir: () => d, os: "darwin" as const, notifier: p.mac.notifier, now: () => Date.now() },
    clip: { backend: p.mac.clipboard, send: { pushText: async () => "applied" as const, pushImage: async () => "applied" as const }, now: () => Date.now(), isEnabled: () => true, log: () => {}, rank: 1 as const, peer: "windows" },
  };
}

describe("aktarim:S günlük ve ping", () => {
  it("yeni op'lar günlüğe girmez; mevcut yan etkili op (launch) girer", async () => {
    const p = await pair();
    const jf = join(p.windows.stateDir, "journal.jsonl");
    for (const [i, op] of [...NEW_OPS.filter((o) => o !== "clip-push"), "launch" as AgentOp].entries()) {
      await p.mac.transport.call("windows", op, {}, { opId: `s-contract-${i}`, timeoutMs: 5000 }).catch(() => {}); // stub gövdeleri hata verir; günlük kaydı sorulur
      const j = existsSync(jf) ? readFileSync(jf, "utf8") : "";
      expect(j.includes(`s-contract-${i}`), op).toBe(op === "launch");
    }
    await p.windows.transport.call("mac", "clip-push", {}, { opId: "s-contract-clip", timeoutMs: 5000 }).catch(() => {});
    const jm = existsSync(join(p.mac.stateDir, "journal.jsonl")) ? readFileSync(join(p.mac.stateDir, "journal.jsonl"), "utf8") : "";
    expect(jm.includes("s-contract-clip")).toBe(false);
  });
  it("ping sonucu caps: xfer, clip (her iki yönde)", async () => {
    const p = await pair();
    const w = (await p.mac.transport.call<{ caps: string[]; machine: string }>("windows", "ping", {})).result;
    const m = (await p.windows.transport.call<{ caps: string[]; machine: string }>("mac", "ping", {})).result;
    expect(w).toMatchObject({ machine: "windows", caps: ["xfer", "clip"] });
    expect(m).toMatchObject({ machine: "mac", caps: ["xfer", "clip"] });
  });
});

describe("aktarim:S harness yüzeyi", () => {
  it("startAktarimPair gözlem yüzeyi ve yaşam döngüsü", async () => {
    const p = await pair({ mac: { clipboard: new FakeClipboard({ bumpPerWrite: 2 }), notifier: new FakeNotifier() } });
    for (const s of [p.mac, p.windows]) {
      expect(existsSync(s.downloads)).toBe(true);
      expect(existsSync(s.stateDir)).toBe(true);
      expect(s.port).toBeGreaterThan(0);
      expect(s.notifier.calls).toEqual([]);
      expect(typeof s.xfer.sweep).toBe("function");
      expect(s.clip.ops["clip-push"]).toBeTypeOf("function");
    }
    expect([p.mac.role, p.windows.role]).toEqual(["brain", "worker"]);
    expect(p.mac.downloads).not.toBe(p.windows.downloads);
    await p.restartAgent("windows");
    expect(p.windows.port).toBeGreaterThan(0);
    await expect(p.mac.transport.call("windows", "ping", {})).resolves.toBeDefined(); // yeni portla çalışır
  });
  it("viaProxy dropResponse sunar ve trafiği gerçekten geçirir", async () => {
    const p = await pair();
    const px = await p.viaProxy("mac");
    expect(typeof px.dropResponse).toBe("function");
    await p.mac.transport.call("windows", "ping", {});
    expect(px.count).toBe(1);
  });
  it("FakeClipboard sürümlü: setLocal seq artırır, bayat yazma reddedilir, writes/reads gözlenir", async () => {
    const c = new FakeClipboard({ bumpPerWrite: 2 });
    const t = (s: string) => ({ kind: "text" as const, bytes: Buffer.from(s) });
    c.setLocal(t("a"));
    const r = await c.read();
    expect(r.content?.bytes.toString()).toBe("a");
    expect(c.reads).toBe(1);
    const w = await c.write(t("b"), r.seq);
    expect(w).toMatchObject({ written: true, seqAfter: r.seq + 2 });
    expect(await c.write(t("c"), r.seq)).toMatchObject({ written: false, reason: "local_changed" });
    expect(c.writes.map((x) => x.bytes.toString())).toEqual(["b"]);
  });
  it("FakeNotifier.failNext bir sonraki çağrıyı düşürür", async () => {
    const n = new FakeNotifier();
    n.failNext();
    await expect(n.notify("t", "b")).rejects.toThrow();
    await n.notify("t2", "b2");
    expect(n.calls).toEqual([{ title: "t2", body: "b2" }]);
  });
  it("makeFile deterministik; treeHash içerik ve ada duyarlı", () => {
    const a = mkdtempSync(join(tmpdir(), "vlad-akt-h-")), b = mkdtempSync(join(tmpdir(), "vlad-akt-h-"));
    temps.push(a, b);
    makeFile(a, "x/f.bin", 1000, 7); makeFile(b, "x/f.bin", 1000, 7);
    expect(treeHash(a)).toBe(treeHash(b));
    makeFile(b, "x/f.bin", 1000, 8);
    expect(treeHash(a)).not.toBe(treeHash(b));
  });
});

describe("aktarim:S native koruma", () => {
  it("testte VLAD_NO_NATIVE=1: nativeAllowed false, assertNative fırlatır", () => {
    expect(process.env.VLAD_NO_NATIVE).toBe("1");
    expect(nativeAllowed()).toBe(false);
    expect(nativeAllowed({})).toBe(true);
    expect(() => assertNative("pano")).toThrow(NativeDisabledError);
  });
  it("gerçek pano/bildirim çalıştırıcısı çağrısı NativeDisabledError ile reddedilir", async () => {
    await expect(createBackend("darwin").read()).rejects.toBeInstanceOf(NativeDisabledError);
    await expect(createNotifier("darwin").notify("t", "b")).rejects.toBeInstanceOf(NativeDisabledError);
  });
  it("alt süreçlere de aktarılır (isolatedEnv korur)", async () => {
    const { isolatedEnv } = await import("../isolate-env.js");
    expect(isolatedEnv().VLAD_NO_NATIVE).toBe("1");
  });
});
