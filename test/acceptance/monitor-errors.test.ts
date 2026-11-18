// monitor-kabul (T20261119-21): hata yolları — şema uyuşmazlığı (7), belirteç sızıntısı (8), erişilemez (9), yetki (10), ardışık hata/status (12),
// Keychain, yapılandırma (13), çıkış kodu eşlemesi. Yalnız sözleşmeden/tasarım raporundan yazıldı; gövdeler henüz yok: testler kırmızı başlar.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMonitorConfig } from "../../src/monitor/config.js";
import { exitCodeOf, monitorStatus, pullAlerts } from "../../src/monitor/pull.js";
import { EXIT_BY_CODE, MONITOR_ERROR_CODES, MONITOR_LIMITS } from "../../src/monitor/types.js";
import type { MonitorErrorCode, PullResult } from "../../src/monitor/types.js";
import { FakeAgent, TOKEN, allText, throwsReal, alertItem, deadUrl, fixture, makeWorld, server, tasksFor } from "./monitor-harness.js";
import type { World } from "./monitor-harness.js";

let agent: FakeAgent;
let w: World;
beforeEach(async () => { agent = await new FakeAgent().start(); w = makeWorld(); });
afterEach(async () => { await agent.stop(); });
const medialog = () => [server("medialog", agent.url)];
const res = (codes: MonitorErrorCode[]): PullResult => ({ servers: [], errors: codes.map((c) => ({ server: null, code: c, message: "x" })) });

describe("monitor-kabul 7: şema sürüm uyuşmazlığı → açık hata", () => {
  it("schema: 2 → schema_mismatch, açık ileti, görev yok, imleç ilerlemez, çıkış 1", async () => {
    agent.upsert(alertItem());
    agent.mutate = (b) => ({ ...b, schema: 2 });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ server: "medialog", code: "schema_mismatch" });
    expect(r.errors[0]!.message).toBe("spc şema uyumsuz: sunucu=medialog, beklenen=1, gelen=2; vendored sözleşmeyi güncelleyin");
    expect(exitCodeOf(r)).toBe(1);
    expect(tasksFor("vlad")).toHaveLength(0);
    expect(r.servers[0]?.ok ?? false).toBe(false);
    expect(existsSync(w.statePath) ? w.readState().servers.medialog?.cursor ?? null : null).toBeNull();
  });

  it.each([
    ["bilinmeyen severity", (b: Record<string, unknown>) => ({ ...b, items: (b.items as Record<string, unknown>[]).map((i) => ({ ...i, severity: "fatal" })) })],
    ["zorunlu alan eksik (alert_id)", (b: Record<string, unknown>) => ({ ...b, items: (b.items as Record<string, unknown>[]).map(({ alert_id: _a, ...rest }) => rest) })],
    ["items dizi değil", (b: Record<string, unknown>) => ({ ...b, items: "yok" })],
  ])("%s → schema_mismatch, görev yok", async (_n, mut) => {
    agent.upsert(alertItem());
    agent.mutate = mut;
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors.map((e) => e.code)).toEqual(["schema_mismatch"]);
    expect(r.errors[0]!.message).toMatch(/^spc şema uyumsuz: sunucu=medialog, beklenen=1, gelen=geçersiz şekil \(/);
    expect(tasksFor("vlad")).toHaveLength(0);
  });

  it("schema alanı yoksa (bugünkü spc) 1 sayılır, ek alanlar yok sayılır: hata yok", async () => {
    agent.upsert(alertItem());
    agent.mutate = (b) => ({ ...b, gelecekte_eklenen: { x: 1 } });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(tasksFor("vlad")).toHaveLength(1);
  });

  it("şema hatası ajanın gönderdiği değeri iletiye taşımaz (enjeksiyon/sızıntı yolu kapalı)", async () => {
    agent.upsert(alertItem());
    agent.mutate = (b) => ({ ...b, items: (b.items as Record<string, unknown>[]).map((i) => ({ ...i, severity: "ENJEKSIYON-DEGERI-42" })) });
    const r = await pullAlerts(w.deps(medialog()));
    expect(JSON.stringify(r)).not.toContain("ENJEKSIYON-DEGERI-42");
  });
});

describe("monitor-kabul 8: belirteç hiçbir çıktıda yok", () => {
  const leakFree = (r: unknown, extra: string[] = []): void => {
    const hay = [JSON.stringify(r), ...w.logs, allText(w.stateDir), allText(join(w.home, "kb")), ...extra].join("\n");
    expect(hay).not.toContain(TOKEN);
    expect(hay).not.toContain(`Bearer ${TOKEN}`);
  };

  it("normal çekiş: sonuç, log, durum dosyası, görev dosyası temiz; ajan belirteci Bearer ile aldı", async () => {
    agent.upsert(alertItem());
    const r = await pullAlerts(w.deps(medialog()));
    expect(agent.requests.length).toBeGreaterThan(0);
    expect(agent.requests.every((q) => q.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(tasksFor("vlad")).toHaveLength(1);
    leakFree(r);
  });

  it("401 (sunucu belirteci iletiye geri yazar): maskelenir", async () => {
    agent.token = "baska";
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors[0]!.code).toBe("unauthorized");
    leakFree(r);
  });

  it("5xx gövdesi belirteci içerse bile çıktıya girmez", async () => {
    agent.forced.push({ status: 500, body: { error: { code: "internal", message: `boom ${TOKEN}`, details: { t: TOKEN } } } });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toHaveLength(1);
    leakFree(r);
  });

  it("ağ hatası (bağlantı reddedildi) ve fetch'in belirteçli hata nedeni: temiz", async () => {
    const f: typeof fetch = async () => { throw Object.assign(new Error(`ECONNREFUSED while sending Bearer ${TOKEN}`), { cause: new Error(TOKEN) }); };
    const r = await pullAlerts(w.deps(medialog(), { fetch: f }));
    expect(r.errors.map((e) => e.code)).toEqual(["unreachable"]);
    leakFree(r);
  });

  it("şema hatası: temiz", async () => {
    agent.upsert(alertItem());
    agent.mutate = (b) => ({ ...b, schema: 2, debug: TOKEN });
    const r = await pullAlerts(w.deps(medialog()));
    leakFree(r);
  });

  it("belirteç yalnız bellekte: Keychain hizmet adı spc_token_<id> (tire → alt çizgi) ile okunur", async () => {
    const w2 = makeWorld(["vlad"], ["my-srv"]);
    const a2 = await new FakeAgent().start();
    try {
      await pullAlerts(w2.deps([server("my-srv", a2.url)]));
      expect(w2.secrets.calls).toContain("spc_token_my_srv");
    } finally { await a2.stop(); }
  });
});

describe("monitor-kabul 9/10: erişilemez ve yetki", () => {
  it("ajan kapalı: unreachable, imleç/görev değişmez, çıkış 1; diğer çağrı yine çalışır", async () => {
    const r = await pullAlerts(w.deps([server("medialog", await deadUrl())]));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ server: "medialog", code: "unreachable" });
    expect(exitCodeOf(r)).toBe(1);
    expect(tasksFor("vlad")).toHaveLength(0);
  });

  it("istek zaman aşımı sinyaliyle yapılır; zaman aşımı hatası unreachable sayılır", async () => {
    let signal: AbortSignal | null | undefined;
    const f: typeof fetch = async (_u, init) => { signal = init?.signal; throw new DOMException("zaman aşımı", "TimeoutError"); };
    const r = await pullAlerts(w.deps(medialog(), { fetch: f }));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(r.errors.map((e) => e.code)).toEqual(["unreachable"]);
  });

  it("401: unauthorized, 'Keychain' ipucu, çıkış 1", async () => {
    const e401 = fixture<{ status: number; body: unknown }>("error-401-unauthorized.json");
    agent.forced.push({ status: e401.status, body: e401.body });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ server: "medialog", code: "unauthorized" });
    expect(r.errors[0]!.message).toMatch(/Keychain/);
    expect(exitCodeOf(r)).toBe(1);
  });

  it("Keychain kaydı yok: keychain hatası (çıkış 2), ajana hiç gidilmez", async () => {
    w.secrets.store.clear();
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors.map((e) => e.code)).toEqual(["keychain"]);
    expect(exitCodeOf(r)).toBe(2);
    expect(agent.requests).toHaveLength(0);
  });
});

describe("monitor-kabul 12: ardışık erişilemezlik ve monitor status", () => {
  it("fail_streak her başarısız çekişte artar; 3'te status 'unreachable'; başarı sıfırlar ve last_ok'u yazar", async () => {
    const dead = await deadUrl();
    for (let i = 1; i <= MONITOR_LIMITS.failStreakWarn; i++) {
      await pullAlerts(w.deps([server("medialog", dead)]));
      expect(w.readState().servers.medialog!.fail_streak).toBe(i);
    }
    const sBad = await monitorStatus({ home: w.home, config: { servers: [server("medialog", dead)] }, stateDir: w.stateDir, now: () => w.clock.t });
    expect(sBad.servers[0]).toMatchObject({ id: "medialog", project: "vlad", fail_streak: MONITOR_LIMITS.failStreakWarn, unreachable: true });
    agent.upsert(alertItem());
    w.clock.t += 300_000;
    const ok = await pullAlerts(w.deps(medialog()));
    expect(ok.errors).toEqual([]);
    const st = w.readState().servers.medialog!;
    expect(st.fail_streak).toBe(0);
    expect(st.last_ok).toBe(w.clock.t);
    const sOk = await monitorStatus({ home: w.home, config: { servers: medialog() }, stateDir: w.stateDir, now: () => w.clock.t });
    expect(sOk.servers[0]).toMatchObject({ unreachable: false, fail_streak: 0, last_ok: w.clock.t });
    expect(sOk.servers[0]!.cursor).toBeTruthy();
  });

  it("eşik altında (2 hata) status unreachable değildir", async () => {
    const dead = await deadUrl();
    for (let i = 0; i < MONITOR_LIMITS.failStreakWarn - 1; i++) await pullAlerts(w.deps([server("medialog", dead)]));
    const s = await monitorStatus({ home: w.home, config: { servers: [server("medialog", dead)] }, stateDir: w.stateDir, now: () => w.clock.t });
    expect(s.servers[0]!.unreachable).toBe(false);
  });

  it("status açık eşlemeleri listeler ve salt okunurdur (durum dosyasını değiştirmez)", async () => {
    const a = agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    const id = tasksFor("vlad")[0]!.data.id;
    const before = readFileSync(w.statePath, "utf8");
    const s = await monitorStatus({ home: w.home, config: { servers: medialog() }, stateDir: w.stateDir, now: () => w.clock.t });
    expect(s.servers[0]!.open_tasks).toEqual([{ alert_id: a.alert_id, task: id }]);
    expect(readFileSync(w.statePath, "utf8")).toBe(before);
  });

  it("durum dosyası yokken status hata vermez (sıfır durum)", async () => {
    const s = await monitorStatus({ home: w.home, config: { servers: medialog() }, stateDir: w.stateDir, now: () => w.clock.t });
    expect(s.servers[0]).toMatchObject({ id: "medialog", cursor: null, last_ok: null, fail_streak: 0, unreachable: false, open_tasks: [] });
  });

  it("bozuk durum dosyası sessizce sıfırlanmaz: pull hata verir ve dosya olduğu gibi kalır", async () => {
    agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    writeFileSync(w.statePath, "{bozuk json");
    const r = await pullAlerts(w.deps(medialog())).catch((e: unknown) => e);
    const failed = r instanceof Error || (r as PullResult).errors.length > 0;
    expect(failed).toBe(true);
    expect(readFileSync(w.statePath, "utf8")).toBe("{bozuk json");
    expect(tasksFor("vlad")).toHaveLength(1);
  });
});

describe("monitor-kabul: çıkış kodu eşlemesi (exitCodeOf)", () => {
  it("hatasız → 0", () => { expect(exitCodeOf(res([]))).toBe(0); });
  it.each(MONITOR_ERROR_CODES.map((c) => [c, EXIT_BY_CODE[c]] as const))("tek hata %s → %i", (c, code) => { expect(exitCodeOf(res([c]))).toBe(code); });
  it("karışık: en kötüsü kazanır (sunucu hatası + keychain → 2)", () => {
    expect(exitCodeOf(res(["unreachable", "keychain"]))).toBe(2);
    expect(exitCodeOf(res(["unreachable", "schema_mismatch"]))).toBe(1);
  });
});

describe("monitor-kabul 13: yapılandırma (loadMonitorConfig)", () => {
  const cfgFile = (home: string, monitor?: unknown): void => writeFileSync(join(home, "vlad.config.json"), JSON.stringify(monitor === undefined ? {} : { monitor }));

  it("monitor bölümü yoksa { servers: [] }", () => {
    cfgFile(w.home);
    expect(loadMonitorConfig(w.home)).toEqual({ servers: [] });
  });
  it("geçerli bölüm aynen okunur", () => {
    const s = [server("medialog", "https://spc.example.test", "vlad")];
    cfgFile(w.home, { servers: s });
    expect(loadMonitorConfig(w.home)).toEqual({ servers: s });
  });
  it("aynı id iki kez → hata", () => {
    cfgFile(w.home, { servers: [server("medialog", "https://a.test"), server("medialog", "https://b.test")] });
    throwsReal(() => loadMonitorConfig(w.home), /medialog/);
  });
  it("kb'de kartı olmayan proje → hata, varsayılan projeye düşülmez", () => {
    cfgFile(w.home, { servers: [server("medialog", "https://a.test", "kartsiz-proje")] });
    throwsReal(() => loadMonitorConfig(w.home), /kartsiz-proje/);
  });
  it("proje alanı yok / geçersiz id → hata", () => {
    cfgFile(w.home, { servers: [{ id: "medialog", agent_url: "https://a.test" }] });
    throwsReal(() => loadMonitorConfig(w.home));
    cfgFile(w.home, { servers: [server("Medialog_X", "https://a.test")] });
    throwsReal(() => loadMonitorConfig(w.home));
  });
  it("yapılandırmada sır alanı kabul edilmez (token/secret ek alanı)", () => {
    cfgFile(w.home, { servers: [{ ...server("medialog", "https://a.test"), token: "SECRET-TOKEN-xyz" }] });
    throwsReal(() => loadMonitorConfig(w.home));
  });
});
