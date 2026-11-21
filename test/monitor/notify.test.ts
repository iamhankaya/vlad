import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countNotices, enqueueNotice, listNotices, markDone, createNotifier, defaultNotifyDir } from "../../src/monitor/notify.js";
import type { ChannelConfig } from "../../src/approver/types.js";
import { IS_WIN } from "../support/platform.js";

let dir: string;
beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), "vlad-notify-")), "notify"); });
afterEach(() => { rmSync(join(dir, ".."), { recursive: true, force: true }); });

const n = (task: string, extra: object = {}) => ({ ts: 1_760_000_000_000, kind: "alert" as const, server: "medialog", task, ...extra });

describe("notify kuyruğu", () => {
  it("varsayılan dizin ~/.vlad-monitor/notify altında", () => {
    expect(defaultNotifyDir("/h")).toBe(join("/h", ".vlad-monitor", "notify"));
  });
  // Windows'ta atlanır: 0700/0600 mod bitleri POSIX'e özgü
  it.skipIf(IS_WIN)("olay başına tek dosya, 0700/0600, belirleyici ad, idempotent", () => {
    enqueueNotice(dir, n("T20261120-01"));
    enqueueNotice(dir, n("T20261120-01"));
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toEqual(["medialog__alert__T20261120-01.json"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, files[0]!), "utf8"))).toEqual({ v: 1, ts: 1_760_000_000_000, kind: "alert", server: "medialog", task: "T20261120-01" });
  });
  it("tetikleyici adın parçasıdır (aynı görev iki tetikleyici)", () => {
    enqueueNotice(dir, n("T1-1", { kind: "capacity", trigger: "ws-concurrent" }));
    enqueueNotice(dir, n("T1-1", { kind: "capacity", trigger: "proc-cpu" }));
    expect(countNotices(dir)).toBe(2);
  });
  it("list ts sırasıyla, limit uygular; bozuk/yabancı dosyalar atlanır, sayaç yalnız geçerlileri sayar", () => {
    enqueueNotice(dir, n("T1-2", { ts: 2000 }));
    enqueueNotice(dir, n("T1-1", { ts: 1000 }));
    writeFileSync(join(dir, "kotu__alert__T9-9.json"), "{bozuk");
    writeFileSync(join(dir, "x.json"), JSON.stringify({ v: 2 }));
    writeFileSync(join(dir, "medialog__alert__T9-8.json"), JSON.stringify({ v: 1, ts: "x", kind: "alert", server: "medialog", task: "T9-8" }));
    const l = listNotices(dir, { limit: 10 });
    expect(l.map((x) => x.task)).toEqual(["T1-1", "T1-2"]);
    expect(listNotices(dir, { limit: 1 })).toHaveLength(1);
    expect(countNotices(dir)).toBe(2);
  });
  it("dizin yoksa boş/0 (SessionStart düşmez)", () => {
    expect(listNotices(join(dir, "yok"))).toEqual([]);
    expect(countNotices(join(dir, "yok"))).toBe(0);
  });
  it("markDone dosyayı done/ altına taşır; id ya da tümü; olmayan id 0", () => {
    enqueueNotice(dir, n("T1-1")); enqueueNotice(dir, n("T1-2")); enqueueNotice(dir, n("T1-3"));
    expect(markDone(dir, "medialog__alert__T1-1")).toBe(1);
    expect(markDone(dir, "medialog__alert__yok")).toBe(0);
    expect(countNotices(dir)).toBe(2);
    expect(existsSync(join(dir, "done", "medialog__alert__T1-1.json"))).toBe(true);
    expect(markDone(dir, "all")).toBe(2);
    expect(countNotices(dir)).toBe(0);
  });
  it("markDone yol geçişini reddeder", () => {
    expect(() => markDone(dir, "../x")).toThrow();
  });
  it("enqueue geçersiz kimlikleri reddeder", () => {
    expect(() => enqueueNotice(dir, n("../x"))).toThrow();
    expect(() => enqueueNotice(dir, n("T1-1", { server: "A/b" }))).toThrow();
  });
});

describe("createNotifier", () => {
  const cfg: ChannelConfig = { v: 1, server: "https://ntfy.example", requestTopic: "vlad-q-secret", createdAt: "x" };
  it("kuyruğa yazar ve ntfy'ye eylemsiz kısa ileti atar; alarm başlığı kuyruğa girmez", async () => {
    const calls: { url: string; body: any }[] = [];
    const f = (async (u: string, init: RequestInit) => { calls.push({ url: u, body: JSON.parse(String(init.body)) }); return new Response("{}"); }) as unknown as typeof fetch;
    const nt = createNotifier({ dir, channel: () => cfg, fetch: f });
    await nt.notice(n("T20261120-05"));
    expect(countNotices(dir)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.message).toContain("T20261120-05");
    expect(calls[0]!.body.actions).toBeUndefined();
    expect(readFileSync(join(dir, readdirSync(dir).find((x) => x.endsWith(".json"))!), "utf8")).not.toMatch(/down|alarm/i);
  });
  it("defer: notice ağa çıkmaz (kuyruk yazılır), flush bekleyenleri eşzamanlı gönderir", async () => {
    let inflight = 0, peak = 0, sent = 0;
    const f = (async () => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 20)); inflight--; sent++; return new Response("{}"); }) as unknown as typeof fetch;
    const nt = createNotifier({ dir, channel: () => cfg, fetch: f, defer: true });
    await nt.notice(n("T1-1")); await nt.notice(n("T1-2")); await nt.notice(n("T1-3"));
    expect(countNotices(dir)).toBe(3);
    expect(sent).toBe(0);
    await nt.flush!();
    expect(sent).toBe(3);
    expect(peak).toBe(3);
    await nt.flush!(); // ikinci flush yeniden göndermez
    expect(sent).toBe(3);
  });
  it("kanal yoksa kuyruk yine yazılır", async () => {
    const nt = createNotifier({ dir, channel: () => null, fetch: (async () => { throw new Error("çağrılmamalı"); }) as unknown as typeof fetch });
    await nt.notice(n("T1-1"));
    expect(countNotices(dir)).toBe(1);
  });
  it("ntfy hatası fırlatmaz, kuyruk yazılı kalır", async () => {
    const logs: string[] = [];
    const nt = createNotifier({ dir, channel: () => cfg, fetch: (async () => { throw new Error("ağ"); }) as unknown as typeof fetch, log: (l) => logs.push(l) });
    await expect(nt.notice(n("T1-1"))).resolves.toBeUndefined();
    expect(countNotices(dir)).toBe(1);
    expect(logs.join("\n")).toMatch(/ntfy/);
  });
  it("kanal okuma hatası fırlatmaz", async () => {
    const nt = createNotifier({ dir, channel: () => { throw new Error("bozuk"); }, fetch });
    await expect(nt.notice(n("T1-1"))).resolves.toBeUndefined();
    expect(countNotices(dir)).toBe(1);
  });
});
