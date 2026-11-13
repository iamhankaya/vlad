import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FORWARD, WORKER_LOCAL } from "../../src/agent/forward.js";
import { RemoteError } from "../../src/fleet/types.js";
import type { Notifier } from "../../src/platform/notify.js";
import { notifySendFailure } from "../../src/transfer/cli.js";
import { rmTemp } from "../helpers.js";
import { makeHomePair, spawnVlad, type HomePair } from "../machines/harness.js";

// V3 (F-vlad-236/237): işçide (Windows) `vlad send` / `vlad clip …` yerelde çalışır; forward reddi yok.
const config = { machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 41001 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: 41002 } }], brain: "mac" };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
function pair(): HomePair {
  const p = makeHomePair({ config });
  cleanups.push(() => rmTemp(dirname(p.brain.home)), () => p.cleanup());
  return p;
}

describe("işçide send/clip forward reddi almaz", () => {
  it.each([
    [["send", "/nonexistent-vlad-x"]],
    [["clip", "status", "--json"]],
    [["clip", "on", "--json"]],
    [["clip", "off", "--json"]],
    [["clip", "get"]],
    [["clip", "set", "x"]],
  ])("%j", (argv) => {
    const p = pair();
    const r = spawnVlad(p.worker, argv, { env: { VLAD_NO_NATIVE: "1" } });
    expect(r.err).not.toMatch(/beyin değil/);
  });

  it("clip status işçide gerçekten çalışır (JSON çıktı, çıkış 0)", () => {
    const r = spawnVlad(pair().worker, ["clip", "status", "--json"], { env: { VLAD_NO_NATIVE: "1" } });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toHaveProperty("enabled");
  });

  it("kontrol: kb yazan komut işçide hâlâ reddedilir", () => {
    const p = pair();
    expect(spawnVlad(p.worker, ["kb", "commit", "x"]).err).toMatch(/beyin değil/);
  });
});

describe("--notify: def/forward düzeyindeki hatalar da bildirilir (F-vlad-237)", () => {
  const rec = () => { const calls: { title: string; body: string }[] = []; return { calls, n: { notify: async (title: string, body: string) => { calls.push({ title, body }); } } as Notifier }; };

  it("bildirilmemiş hata → genel başlıkla bildirim", async () => {
    const r = rec();
    await notifySendFailure(new Error("bu makine beyin değil"), { notify: true }, { notifier: r.n });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.title).toBe("Gönderilemedi");
    expect(r.calls[0]!.body).toContain("bu makine beyin değil");
  });
  it("--notify yok → bildirim yok", async () => {
    const r = rec();
    await notifySendFailure(new Error("x"), {}, { notifier: r.n });
    expect(r.calls).toHaveLength(0);
  });
  it("runSendCommand zaten bildirdiyse tekrar bildirmez", async () => {
    const { runSendCommand } = await import("../../src/transfer/cli.js");
    const r = rec();
    const e = await runSendCommand(["/x"], { notify: true }, { cfg: { machines: [], brain: "mac" } as any, self: "mac", notifier: r.n }).then(() => null, (x) => x);
    expect(e).toBeTruthy();
    expect(r.calls).toHaveLength(1);
    await notifySendFailure(e, { notify: true }, { notifier: r.n });
    expect(r.calls).toHaveLength(1);
  });
  it("bildirici patlarsa hata yutulur", async () => {
    await expect(notifySendFailure(new RemoteError("failed", "x"), { notify: true }, { notifier: { notify: async () => { throw new Error("toast"); } } })).resolves.toBeUndefined();
  });
});

// Sözleşme: cli.ts'deki her def() anahtarı WORKER_LOCAL, FORWARD ya da açık "yalnız beyin" listesinde olmalı.
const BRAIN_ONLY = new Set([
  "project write", "project set", "project note", "project summary", "project refresh",
  "finding add", "finding set", "idea add", "idea set", "idea promote", "idea from-finding",
  "task new", "task launch", "task release", "task repin", "task ingest", "task answer", "task set", "task deps", "task resume", "task cleanup", "task close", "task gate", "task merge-preview", "task merge", "task digested",
  "mode night", "mode watch", "mode off", "mode status", "mode token",
  "audit setup",
  "inbox done", "pending add", "pending done", "decision add", "decision set", "decision migrate", "journal append",
  "kb commit", "kb maintain", "kb lint", "session register", "machine scripts", "machine run",
]);

function defKeys(): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../src/cli/groups"); // U3: the commands live in cli/groups/*.ts
  const src = readdirSync(dir).filter((f) => f.endsWith(".ts")).sort().map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const names: Record<string, string> = { program: "vlad" };
  for (const m of src.matchAll(/const (\w+) = (\w+)\.command\("([^"]+)"\)/g)) names[m[1]!] = m[3]!;
  const keys: string[] = [];
  for (const m of src.matchAll(/^\s*def\((\w+), "([^"\s]+)/gm)) keys.push(`${names[m[1]!] ?? `?${m[1]}`} ${m[2]}`);
  return keys;
}

describe("komut sınıflandırma sözleşmesi", () => {
  it("her def() anahtarı WORKER_LOCAL, FORWARD ya da BRAIN_ONLY'de (yeni komut unutulamaz)", () => {
    const keys = defKeys();
    expect(keys.length).toBeGreaterThan(60);
    expect(keys.filter((k) => k.includes("?"))).toEqual([]);
    const unclassified = keys.filter((k) => !WORKER_LOCAL.has(k) && !(k in FORWARD) && !BRAIN_ONLY.has(k));
    expect(unclassified).toEqual([]);
  });
  it("bir anahtar birden çok listede olamaz; listelerde olmayan (ölü) anahtar yok", () => {
    const keys = new Set(defKeys());
    for (const k of BRAIN_ONLY) { expect(WORKER_LOCAL.has(k), k).toBe(false); expect(k in FORWARD, k).toBe(false); }
    for (const k of Object.keys(FORWARD)) expect(WORKER_LOCAL.has(k), k).toBe(false);
    const dead = [...WORKER_LOCAL, ...Object.keys(FORWARD), ...BRAIN_ONLY].filter((k) => !keys.has(k));
    expect(dead).toEqual([]);
  });
});
