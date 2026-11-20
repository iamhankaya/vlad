import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { getTask, listTasks, setState } from "../../src/tasks/index.js";
import { capacityExitCode, runCapacity, type CapacityDeps } from "../../src/monitor/capacity.js";
import { capacityMarker } from "../../src/monitor/marker.js";
import { isoWeekKey } from "../../src/monitor/capacity-calc.js";
import type { Notice } from "../../src/monitor/notify.js";

const DAY = 86_400_000;
const TOKEN = "SECRET-CAP-RUN";
const W0 = Date.UTC(2026, 10, 23, 9, 0, 0); // Pazartesi 09:00 UTC (2026-W48)
const FIXTURE = join(__dirname, "..", "fixtures", "spc", "capacity-medialog.yaml");

let stateDir: string, capFile: string, logs: string[], notices: Notice[];
beforeEach(() => {
  const home = makeHome();
  cpSync(join(__dirname, "..", "..", "roles"), join(home, "roles"), { recursive: true });
  writeFileSync(join(home, "kb", "projects", "p.md"), "---\nslug: p\n---\n");
  stateDir = mkdtempSync(join(tmpdir(), "vlad-cap-"));
  capFile = join(stateDir, "capacity.yaml");
  cpSync(FIXTURE, capFile);
  logs = []; notices = [];
});
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

/** Ajan sahtesi: metrik → günlük zirve işlevi (d = `now`dan kaç gün önce). Yalnız istenen metrikler için öğe üretir. */
type Gen = Record<string, (d: number) => number | null>;
function agent(now: () => number, gen: () => Gen, status = () => 200, server = "medialog") {
  const calls: URL[] = [];
  const f = (async (u: string, init: RequestInit) => {
    calls.push(new URL(u));
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    if (status() !== 200) return new Response("{}", { status: status() });
    const items: unknown[] = [];
    let seq = 1;
    for (const [metric, fn] of Object.entries(gen())) {
      const labels = metric.startsWith("docker.") ? { name: "medialog-app-1" } : {};
      for (let d = 29; d >= 0; d--) {
        const v = fn(d);
        if (v === null) continue;
        items.push({ seq: seq++, ts: Math.floor(now() / DAY) * DAY - d * DAY + 3_600_000, metric, labels, n: 10, min: 0, max: v, avg: v, last: v });
      }
    }
    return new Response(JSON.stringify({ server, epoch: "e", resolution: "1m", schema: 1, items, next_cursor: "c", has_more: false, gap: null, oldest_ts: now() - 29 * DAY }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
/** ws_connections haftalık zirveleri eskiden yeniye (4 hafta). */
const ws = (weeks: number[]): Gen => ({ "app.ws_connections": (d) => weeks[3 - Math.floor(d / 7)] ?? null });

function mk(over: Partial<CapacityDeps> & { now?: () => number; gen?: () => Gen; status?: () => number } = {}) {
  const now = over.now ?? (() => W0);
  const a = agent(now, over.gen ?? (() => ws([150, 180, 210, 240])), over.status);
  const deps: CapacityDeps = {
    home: process.env.VLAD_HOME!,
    config: { servers: [{ id: "medialog", agent_url: "http://127.0.0.1:9", project: "p", capacity_file: capFile }] },
    secrets: { read: async () => TOKEN }, fetch: a.f, now, stateDir, platform: "darwin", log: (l) => logs.push(l),
    notifier: { notice: async (n) => { notices.push(n); } },
    ...over,
  };
  delete (deps as Record<string, unknown>).gen; delete (deps as Record<string, unknown>).status;
  return { deps, calls: a.calls };
}
const reportTask = () => listTasks().find((t) => t.data.title === "[spc] kapasite raporu: medialog");
const architects = () => listTasks().filter((t) => t.data.role === "architect");
const stateFile = () => JSON.parse(readFileSync(join(stateDir, "capacity.json"), "utf8"));

describe("runCapacity: ilk koşu", () => {
  it("rapor görevi + warn için tek architect görevi (açık uçlu gövde, işaret, eşli proje); bildirim; durum", async () => {
    const { deps } = mk();
    const r = await runCapacity(deps);
    expect(r.errors).toEqual([]);
    expect(r.servers[0]).toMatchObject({ id: "medialog", ok: true, week: "2026-W48", skipped: null });
    const rep = reportTask()!;
    expect(rep.data).toMatchObject({ kind: "research", role: "analyst", project: "p", state: "queued" });
    expect(rep.body).toContain("spc-capacity-report: medialog");
    expect(rep.body).toMatch(/\| ws-concurrent \| 240 bağlantı \| 240 bağlantı \| >= 300 bağlantı \| %80 \| \+30 bağlantı\/hafta \| 2 hafta \| warn \|/);
    expect(rep.body).toContain("veri başlangıcı: 2026-10-25");
    const a = architects();
    expect(a).toHaveLength(1);
    expect(a[0]!.data).toMatchObject({ kind: "research", role: "architect", project: "p", state: "queued" });
    expect(a[0]!.body.split("\n")).toContain(capacityMarker("medialog", "ws-concurrent"));
    expect(a[0]!.body).toMatch(/Seçenekler açık uçludur/);
    expect(a[0]!.body).toMatch(/yalnız örnektir/);
    expect(a[0]!.body).toMatch(/önbellek/);
    expect(a[0]!.body).toMatch(/hiçbir şey yapmama/);
    expect(r.servers[0]!.opened).toEqual([{ trigger: "ws-concurrent", task: a[0]!.data.id }]);
    expect(notices).toEqual([{ ts: W0, kind: "capacity", server: "medialog", task: a[0]!.data.id, trigger: "ws-concurrent" }]);
    const st = stateFile();
    expect(st.servers.medialog.last_week).toBe("2026-W48");
    expect(st.servers.medialog.triggers["ws-concurrent"].architect_task).toBe(a[0]!.data.id);
    expect(capacityExitCode(r)).toBe(0);
  });
  it("veri hiç yok / ok: architect görevi açılmaz", async () => {
    const { deps } = mk({ gen: () => ws([20, 20, 20, 20]) });
    await runCapacity(deps);
    expect(architects()).toHaveLength(0);
    expect(reportTask()).toBeTruthy();
    expect(notices).toEqual([]);
  });
});

describe("runCapacity: idempotans ve haftalar", () => {
  it("aynı hafta tekrar koşu hiçbir yazma yapmaz; --force yeniden yazar", async () => {
    const { deps, calls } = mk();
    await runCapacity(deps);
    const before = readFileSync(reportTask()!.file, "utf8");
    const n = calls.length;
    const r2 = await runCapacity(deps);
    expect(r2.servers[0]!.skipped).toBe("already_done");
    expect(calls.length).toBe(n); // ağa gidilmez
    expect(readFileSync(reportTask()!.file, "utf8")).toBe(before);
    expect(architects()).toHaveLength(1);
    await runCapacity(deps, { force: true });
    expect(readFileSync(reportTask()!.file, "utf8")).not.toBe(before);
    expect(architects()).toHaveLength(1);
  });
  it("ikinci hafta: yeni görev yok; rapor tablosu eklenir, açık architect görevinin günlüğüne satır düşer", async () => {
    let now = W0;
    const { deps } = mk({ now: () => now, gen: () => ws([150, 180, 210, 240]) });
    await runCapacity(deps);
    now = W0 + 7 * DAY;
    await runCapacity(deps);
    expect(architects()).toHaveLength(1);
    expect(reportTask()!.body.match(/kapasite raporu 2026-W/g)).toHaveLength(2);
    expect(architects()[0]!.body).toMatch(/kapasite 2026-W49:[\s\S]*\| ws-concurrent \|/);
    expect(notices).toHaveLength(1); // yalnız ilk açılış
  });
  it("görev kapatılınca warn yeniden açmaz, over açar", async () => {
    let now = W0;
    let gen = ws([150, 180, 210, 240]);
    const { deps } = mk({ now: () => now, gen: () => gen });
    await runCapacity(deps);
    setState(architects()[0]!.data.id, "cancelled");
    now = W0 + 7 * DAY;
    await runCapacity(deps);
    expect(architects()).toHaveLength(1); // warn: yeni görev yok
    now = W0 + 14 * DAY;
    gen = ws([180, 210, 240, 320]); // 320 >= 300 → over
    await runCapacity(deps);
    const open = architects().filter((t) => t.data.state === "queued");
    expect(open).toHaveLength(1);
    expect(architects()).toHaveLength(2);
    expect(notices.at(-1)).toMatchObject({ kind: "capacity", trigger: "ws-concurrent", task: open[0]!.data.id });
  });
  it("iki ardışık over haftası '2 ardışık' notunu yazar; arada atlanan hafta seriyi sıfırlar", async () => {
    let now = W0;
    const { deps } = mk({ now: () => now, gen: () => ws([250, 280, 310, 330]) });
    await runCapacity(deps);
    expect(architects()[0]!.body).not.toMatch(/ardışık hafta eşiği aştı/);
    now = W0 + 7 * DAY;
    await runCapacity(deps);
    expect(architects()[0]!.body).toMatch(/TETİKLEYİCİ: ws-concurrent 2 ardışık hafta eşiği aştı \(2026-W48, 2026-W49\)/);
    expect(stateFile().servers.medialog.triggers["ws-concurrent"].over_weeks).toEqual(["2026-W48", "2026-W49"]);
    expect(notices).toHaveLength(2); // açılış + eşiğin ilk aşılışı (iki ardışık)
    now = W0 + 14 * DAY;
    await runCapacity(deps); // W50: üçüncü ardışık hafta → yeni bildirim yok
    expect(notices).toHaveLength(2);
    // bir hafta atla (W51 yok), W52'de koş
    now = W0 + 28 * DAY;
    await runCapacity(deps);
    expect(stateFile().servers.medialog.triggers["ws-concurrent"].over_weeks).toEqual(["2026-W52"]);
    expect(reportTask()!.body).toMatch(/Not: hafta atlandı \(önceki rapor 2026-W50\)/);
  });
});

describe("runCapacity: hatalar ve kapsam", () => {
  it("ulaşılamaz sunucu atlanır (yazma yok, durum ilerlemez), diğeri sürer", async () => {
    const good = agent(() => W0, () => ws([150, 180, 210, 240]), () => 200, "other");
    const f = (async (u: string, init: RequestInit) => (String(u).startsWith("http://127.0.0.1:9") ? Promise.reject(new TypeError("x")) : good.f(u, init))) as unknown as typeof fetch;
    const cap2 = join(stateDir, "cap2.yaml");
    writeFileSync(cap2, readFileSync(FIXTURE, "utf8").replace("server: medialog", "server: other"));
    const { deps } = mk({ fetch: f, config: { servers: [
      { id: "medialog", agent_url: "http://127.0.0.1:9", project: "p", capacity_file: capFile },
      { id: "other", agent_url: "http://127.0.0.1:8", project: "p", capacity_file: cap2 },
    ] } });
    const r = await runCapacity(deps);
    expect(r.errors.map((e) => [e.server, e.code])).toEqual([["medialog", "unreachable"]]);
    expect(capacityExitCode(r)).toBe(1);
    expect(stateFile().servers.medialog).toBeUndefined();
    expect(r.servers.find((s) => s.id === "other")).toMatchObject({ ok: true, skipped: null });
    expect(stateFile().servers.other.last_week).toBe("2026-W48");
    expect(listTasks().filter((t) => t.data.role === "architect")).toHaveLength(1);
  });
  it("401 → unauthorized + Keychain ipucu; Keychain kaydı yok → keychain; belirteç çıktıda yok", async () => {
    const r = await runCapacity(mk({ status: () => 401 }).deps);
    expect(r.errors[0]).toMatchObject({ code: "unauthorized" });
    expect(r.errors[0]!.message).toContain("Keychain");
    const r2 = await runCapacity(mk({ secrets: { read: async () => null } }).deps);
    expect(r2.errors[0]!.code).toBe("keychain");
    expect(capacityExitCode(r2)).toBe(2);
    expect(JSON.stringify([r, r2, logs])).not.toContain(TOKEN);
    expect(reportTask()).toBeUndefined();
  });
  it("capacity_file yok → atlanır (hata değil); --server ile açıkça istenirse config hatası", async () => {
    const config = { servers: [{ id: "medialog", agent_url: "http://127.0.0.1:9", project: "p" }] };
    const r = await runCapacity(mk({ config }).deps);
    expect(r.errors).toEqual([]);
    expect(r.servers[0]).toMatchObject({ skipped: "no_capacity_file", ok: true });
    expect(logs.join("\n")).toMatch(/capacity_file/);
    const r2 = await runCapacity(mk({ config }).deps, { server: "medialog" });
    expect(r2.errors[0]).toMatchObject({ code: "config" });
    expect(capacityExitCode(r2)).toBe(2);
  });
  it("bozuk capacity.yaml / sunucu uyuşmazlığı → config, ağa gidilmez", async () => {
    writeFileSync(capFile, "version: 2\n");
    const { deps, calls } = mk();
    const r = await runCapacity(deps);
    expect(r.errors[0]).toMatchObject({ code: "config" });
    expect(calls).toHaveLength(0);
    cpSync(FIXTURE, capFile);
    writeFileSync(capFile, readFileSync(FIXTURE, "utf8").replace("server: medialog", "server: baska"));
    expect((await runCapacity(mk().deps)).errors[0]!.message).toMatch(/uyuşmuyor/);
  });
  it("Mac dışı → unsupported_platform; bilinmeyen --server → config", async () => {
    expect((await runCapacity(mk({ platform: "win32" }).deps)).errors[0]!.code).toBe("unsupported_platform");
    expect((await runCapacity(mk().deps, { server: "zzz" })).errors[0]!.code).toBe("config");
  });
  it("--dry-run hiçbir şey yazmaz (kb, durum, bildirim) ama sonucu hesaplar", async () => {
    const r = await runCapacity(mk().deps, { dryRun: true });
    expect(listTasks()).toHaveLength(0);
    expect(existsSync(join(stateDir, "capacity.json"))).toBe(false);
    expect(notices).toEqual([]);
    expect(r.servers[0]!.triggers.find((t) => t.id === "ws-concurrent")!.status).toBe("warn");
    expect(r.servers[0]!.opened).toHaveLength(1);
  });
  it("bildirim hatası sonucu/çıkış kodunu etkilemez; kb'ye commit yapılmaz (yalnız görev dosyaları)", async () => {
    const { deps } = mk({ notifier: { notice: async () => { throw new Error("patladı"); } } });
    const r = await runCapacity(deps);
    expect(r.errors).toEqual([]);
    expect(architects()).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/bildirim/);
  });
  it("ajan metni yok: görev gövdelerinde yalnız yapılandırma/sayısal veri", async () => {
    await runCapacity(mk().deps);
    for (const t of listTasks()) expect(getTask(t.data.id).body).not.toContain(TOKEN);
  });
});

/** 1.1 ajanı sahtesi: haftalık seyir eskiden yeniye (4 hafta; ws ile aynı yerleşim). */
const wk = (weeks: number[]) => (d: number): number | null => weeks[3 - Math.floor(d / 7)] ?? null;

describe("runCapacity: hata oranı ve ürün büyümesi (spc 1.1.0, fixture TÜRETİLMİŞ: F-vlad-362)", () => {
  it("rapor tablodan sonra 'Hata oranı ve ürün büyümesi' bölümü yazar: eşikli satırlar + trend satırı haftalık değerle", async () => {
    const gen: Gen = { "http.err5xx_pct": wk([0.1, 0.1, 0.1, 0.1]), "app.ext_tmdb_p95_ms_5m": wk([400, 410, 420, 430]), "app.product_active_7d": wk([23, 26, 29, 31]) };
    await runCapacity(mk({ gen: () => gen }).deps);
    const txt = reportTask()!.body;
    expect(txt.indexOf("Hata oranı ve ürün büyümesi")).toBeGreaterThan(txt.indexOf("| tetikleyici |"));
    expect(txt).toMatch(/\| product-active \| Ürün büyümesi \(7 gün aktif kullanıcı\) \| 23 → 31 kişi \| \+2,7\/hafta \| eğilim \|/);
    expect(txt).toMatch(/\| http-5xx \| HTTP 5xx oranı \| 0,1 → 0,1 % \| \+0\/hafta \| ok \|/);
    expect(txt).toMatch(/\| tmdb-p95 \| TMDB çağrı p95 gecikmesi \| 400 → 430 ms \| \+10\/hafta \| ok \|/);
    // trend satırı ana eşik tablosunda yok (eşiği yok)
    expect(txt.split("Hata oranı ve ürün büyümesi")[0]).not.toContain("| product-active |");
  });
  it("trend tetikleyicisi görev açmaz, bildirim düşürmez; durumda tetikleyici sayacı yok", async () => {
    const r = await runCapacity(mk({ gen: () => ({ "app.product_active_7d": wk([10, 100, 1000, 100000]) }) }).deps);
    expect(architects()).toHaveLength(0);
    expect(notices).toEqual([]);
    const t = r.servers[0]!.triggers.find((x) => x.id === "product-active")!;
    expect(t.status).toBe("ok");
    expect(t.pct).toBeNull();
    expect(stateFile().servers.medialog.triggers["product-active"]).toBeUndefined();
  });
  it("tek hafta trend verisi: insufficient ama satır yine yazılır", async () => {
    const r = await runCapacity(mk({ gen: () => ({ "app.product_active_7d": (d: number) => (d < 5 ? 25 : null) }) }).deps);
    expect(r.servers[0]!.triggers.find((x) => x.id === "product-active")!.status).toBe("insufficient");
    expect(reportTask()!.body).toMatch(/\| product-active \| [^|]+ \| 25 kişi \| - \| yetersiz veri \|/);
  });
  it("eski 1.0 ajanı (yalnız eski metrikler): yeni tetikleyiciler 'veri yok (ajan 1.1 gerekli)', görev açılmaz; 1.0 metriği eksikliği bunu söylemez", async () => {
    const r = await runCapacity(mk({ gen: () => ws([20, 20, 20, 20]) }).deps);
    expect(r.errors).toEqual([]);
    expect(architects()).toHaveLength(0);
    const txt = reportTask()!.body;
    for (const id of ["sys-load5", "pg-cache", "http-5xx", "tmdb-p95"]) expect(txt).toMatch(new RegExp(`\\| ${id} \\|[^\\n]*veri yok \\(ajan 1\\.1 gerekli\\)`));
    expect(txt).toMatch(/\| product-active \| [^|]+ \| veri yok \(ajan 1\.1 gerekli\) \| - \| yetersiz veri \|/);
    expect(txt).not.toMatch(/\| proc-cpu \|[^\n]*ajan 1\.1 gerekli/);
    expect(txt).toMatch(/\| proc-cpu \|[^\n]*yetersiz veri/);
  });
  it("pg.cache_hit_pct sabit 99,5: remaining 'artmıyor', warn ve görev yok", async () => {
    await runCapacity(mk({ gen: () => ({ "pg.cache_hit_pct": wk([99.5, 99.5, 99.5, 99.5]) }) }).deps);
    expect(architects()).toHaveLength(0);
    expect(reportTask()!.body).toMatch(/\| pg-cache \|[^\n]*\| artmıyor \| ok \|/);
  });
  it("düşen önbellek isabeti eşiğe yaklaşınca tek architect görevi (gövdede '<' eşiği ve en düşük değer anlatımı)", async () => {
    const r = await runCapacity(mk({ gen: () => ({ "pg.cache_hit_pct": wk([99.5, 99, 98, 97]) }) }).deps);
    expect(r.servers[0]!.triggers.find((x) => x.id === "pg-cache")!.status).toBe("warn");
    const a = architects();
    expect(a).toHaveLength(1);
    expect(a[0]!.body.split("\n")).toContain(capacityMarker("medialog", "pg-cache"));
    expect(a[0]!.body).toMatch(/eşik < 95 %/);
    expect(a[0]!.body).toMatch(/en düşü/);
  });
  it("fixture yeniden oynatma (since-medialog-1.1.json): rapor + yalnız eşiğe yaklaşanlar için görev", async () => {
    const fx = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "spc", "since-medialog-1.1.json"), "utf8"));
    const f = (async () => new Response(JSON.stringify(fx), { status: 200 })) as unknown as typeof fetch;
    const r = await runCapacity(mk({ fetch: f }).deps);
    expect(r.errors).toEqual([]);
    const st = Object.fromEntries(r.servers[0]!.triggers.map((t) => [t.id, t.status]));
    expect(st).toMatchObject({ "sys-load5": "ok", "pg-cache": "warn", "http-5xx": "warn", "product-active": "ok", "ws-concurrent": "insufficient" });
    expect(architects().map((t) => t.data.title).sort()).toEqual([
      "[spc] kapasite: medialog/http-5xx — HTTP 5xx oranı",
      "[spc] kapasite: medialog/pg-cache — Postgres önbellek isabeti (düşükse kötü)",
    ]);
    expect(reportTask()!.body).toMatch(/\| product-active \| [^|]+ \| 23 → 31 kişi \| \+2,7\/hafta \| eğilim \|/);
  });
});

describe("isoWeekKey uyumu", () => {
  it("test varsayımı: W0 = 2026-W48", () => { expect(isoWeekKey(W0)).toBe("2026-W48"); });
});
