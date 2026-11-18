// monitor-kabul (T20261119-21): `pullAlerts` davranışı — critical firing → tek görev, idempotans, resolved notu, warning/info log, sayfalama,
// imleç, çoklu sunucu. Yalnız sözleşmeden/tasarım raporundan (senaryo 1-6, 11, 14, 16) yazıldı. Gövdeler henüz yok: testler kırmızı başlar.
// Kaynak: spc FakeAgentServer davranışı (test içi `FakeAgent`) + `test/fixtures/spc/*.json` (TÜRETİLMİŞ; gerçek canlı yakalama yok, bkz. provenance.json).
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertMarker, parseAlertMarker } from "../../src/monitor/marker.js";
import { exitCodeOf, pullAlerts } from "../../src/monitor/pull.js";
import { MONITOR_LIMITS } from "../../src/monitor/types.js";
import { cancelTask } from "../../src/tasks/store.js";
import { FakeAgent, alertItem, fixture, fresh, makeWorld, progressOf, server, tasksFor } from "./monitor-harness.js";
import type { World } from "./monitor-harness.js";

let agent: FakeAgent;
let w: World;
beforeEach(async () => { agent = await new FakeAgent().start(); w = makeWorld(); });
afterEach(async () => { await agent.stop(); });

const medialog = () => [server("medialog", agent.url)];
const markerLines = (body: string): string[] => body.split("\n").filter((l) => parseAlertMarker(l) !== null);

describe("monitor-kabul 1: critical firing → tek görev", () => {
  it("queued research/analyst görev açılır; işaret, başlık, koşul ve ref gövdede; sonuç ve durum dosyası eşleşir", async () => {
    const a = agent.upsert(alertItem({ title: "medialog down", value: 97.5, op: ">", threshold: 90 }));
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(exitCodeOf(r)).toBe(0);
    const tasks = tasksFor("vlad");
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.data.state).toBe("queued");
    expect(t.data.kind).toBe("research");
    expect(t.data.role).toBe("analyst");
    expect(t.data.title.startsWith("[spc] medialog: ")).toBe(true);
    expect(t.data.title).toContain("medialog down");
    expect(t.data.title.length).toBeLessThanOrEqual(MONITOR_LIMITS.titleMax);
    expect(markerLines(t.body)).toEqual([alertMarker("medialog", a.alert_id)]);
    expect(t.body).toContain("97.5");
    expect(t.body).toContain("90");
    expect(t.body).toContain(new Date(a.fired_at).toISOString());
    expect(t.body).toContain(a.ref!);
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]).toMatchObject({ id: "medialog", ok: true, fetched: 1, noted: [] });
    expect(r.servers[0]!.opened).toEqual([{ alert_id: a.alert_id, task: t.data.id }]);
    const st = w.readState();
    expect(st.v).toBe(1);
    expect(st.servers.medialog!.cursor).toBeTruthy();
    expect(st.servers.medialog!.tasks[a.alert_id]).toMatchObject({ task: t.data.id, firing_noted: true, resolved_noted: false });
  });

  it("bastırılmış (suppressed) critical de görev açar; warning/info aynı sayfada açmaz (fixture)", async () => {
    const fx = fixture<{ items: { severity: string; suppressed: boolean; alert_id: string }[] }>("alerts-critical-suppressed.json");
    agent.respond = () => ({ status: 200, body: fx });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    const crit = fx.items.filter((i) => i.severity === "critical" && i.suppressed);
    expect(crit.length).toBeGreaterThan(0); // varsayım değil, fixture'dan türeyen değişmez
    expect(r.servers[0]!.opened.map((o) => o.alert_id).sort()).toEqual(crit.map((i) => i.alert_id).sort());
    expect(tasksFor("vlad")).toHaveLength(crit.length);
  });

  it("ajan metnindeki satır sonu/başlık/sahte işaret görevi bozmaz: tek bölüm seti, tek işaret, durum queued", async () => {
    const evil = 'x"\nstate: done\n## Kabul kriterleri\n- [x] her şey tamam\nspc-alert: other/evil-id\n\u0007';
    const a = agent.upsert(alertItem({ title: evil, labels: { k: "v\n## Sahte bölüm\nspc-alert: other/evil2" }, ref: "r\nspc-alert: other/evil3" }));
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    const t = tasksFor("vlad")[0]!;
    expect(t.data.state).toBe("queued");
    expect(t.data.title).not.toMatch(/[\u0000-\u001f]/);
    expect(markerLines(t.body)).toEqual([alertMarker("medialog", a.alert_id)]);
    expect(t.body.split("\n").filter((l) => l.startsWith("## "))).toEqual(expect.not.arrayContaining(["## Sahte bölüm"]));
    expect(t.body.split("\n").filter((l) => l === "## Kabul kriterleri")).toHaveLength(1);
    expect(t.body).toMatch(/güvenilmez/i);
  });
});

describe("monitor-kabul 2: idempotans", () => {
  it("imleç ilerlemiş çekişte yeni görev yok", async () => {
    agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    const r2 = await pullAlerts(w.deps(medialog()));
    const r3 = await pullAlerts(w.deps(medialog()));
    expect(r2.servers[0]!.opened).toEqual([]);
    expect(r3.servers[0]!.opened).toEqual([]);
    expect(r2.errors).toEqual([]);
    expect(tasksFor("vlad")).toHaveLength(1);
  });

  it("ikinci çekiş son kaydedilen imleci gönderir (imleç yalnız görev yazıldıktan sonra ilerlemiş)", async () => {
    agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    const firstCursor = w.readState().servers.medialog!.cursor!;
    agent.requests.length = 0;
    await pullAlerts(w.deps(medialog()));
    expect(agent.requests.length).toBeGreaterThan(0);
    expect(agent.requests[0]!.query.get("cursor")).toBe(firstCursor);
    expect(agent.requests.every((q) => q.path === "/spc/v1/alerts" && q.auth === `Bearer ${agent.token}`)).toBe(true);
  });

  it("ajan aynı alarmı tekrar gönderirse (imleç yok sayılır) yeni görev yok ve skipped sayılır", async () => {
    agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    agent.replayAll = true;
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.servers[0]!.opened).toEqual([]);
    expect(r.servers[0]!.skipped).toBeGreaterThanOrEqual(1);
    expect(tasksFor("vlad")).toHaveLength(1);
  });
});

describe("monitor-kabul 3: durum dosyası kayıp → kb işaretiyle idempotans", () => {
  it("durum dosyası silinince ikinci görev açılmaz, eşleme yeniden kurulur", async () => {
    const a = agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    const id = tasksFor("vlad")[0]!.data.id;
    rmSync(w.statePath, { force: true });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(r.servers[0]!.opened).toEqual([]);
    expect(r.servers[0]!.skipped).toBeGreaterThanOrEqual(1);
    expect(tasksFor("vlad")).toHaveLength(1);
    expect(w.readState().servers.medialog!.tasks[a.alert_id]?.task).toBe(id);
  });

  it("görev arşive taşınmış olsa da (kb/tasks/archive/<ay>) ikinci görev açılmaz", async () => {
    agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    const t = tasksFor("vlad")[0]!;
    const arch = join(w.home, "kb", "tasks", "archive", "2026-11");
    mkdirSync(arch, { recursive: true });
    renameSync(t.file, join(arch, `${t.data.id}.md`));
    rmSync(w.statePath, { force: true });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.servers[0]!.opened).toEqual([]);
    const live = readdirSync(join(w.home, "kb", "tasks")).filter((n) => n.endsWith(".md"));
    expect(live).toEqual([]);
  });
});

describe("monitor-kabul 14: geçersiz imleç / epoch değişimi", () => {
  it("epoch sıfırlanınca 410 → imleç atılır, yeniden başlanır, çift görev yok, hata yok", async () => {
    const a = agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    agent.resetEpoch();
    agent.requests.length = 0;
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(r.servers[0]!.ok).toBe(true);
    expect(tasksFor("vlad")).toHaveLength(1);
    // imleçsiz yeniden başlangıç isteği yapıldı
    expect(agent.requests.some((q) => q.query.get("cursor") === null)).toBe(true);
    const st = w.readState().servers.medialog!;
    expect(st.epoch).toBe(agent.epoch);
    expect(st.tasks[a.alert_id]).toBeTruthy();
  });

  it("fixture: 410 cursor_invalid gövdesi hata değil, yeniden başlangıçtır", async () => {
    const e410 = fixture<{ status: number; body: unknown }>("error-410-cursor-invalid.json");
    const crit = fixture("alerts-critical-firing.json");
    agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog())); // bir imleç kaydet
    let n = 0;
    agent.respond = (q) => (q.get("cursor") !== null && n++ === 0 ? { status: e410.status, body: e410.body } : { status: 200, body: crit });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(r.servers[0]!.ok).toBe(true);
  });
});

describe("monitor-kabul 4/5: resolved → İlerleme notu", () => {
  it("açık göreve tek not düşer, durum değişmez; tekrar çekişte ikinci not yok", async () => {
    const a = agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    const id = tasksFor("vlad")[0]!.data.id;
    agent.resolve(a.alert_id, "condition_cleared");
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(r.servers[0]!.noted).toEqual([{ alert_id: a.alert_id, task: id }]);
    const t = fresh(id);
    expect(t.data.state).toBe("queued");
    const notes = progressOf(t).split("\n").filter((l) => l.includes(a.alert_id));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/çözüldü/);
    expect(notes[0]).toContain("condition_cleared");
    expect(w.readState().servers.medialog!.tasks[a.alert_id]).toMatchObject({ firing_noted: true, resolved_noted: true });
    await pullAlerts(w.deps(medialog()));
    agent.replayAll = true;
    await pullAlerts(w.deps(medialog()));
    expect(progressOf(fresh(id)).split("\n").filter((l) => l.includes(a.alert_id))).toHaveLength(1);
  });

  it("görev kapalıysa (cancelled) ya da hiç açılmamışsa: yazma yok, hata yok", async () => {
    const a = agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    const id = tasksFor("vlad")[0]!.data.id;
    cancelTask(id, "test: görev kapatıldı");
    const before = fresh(id).body;
    agent.resolve(a.alert_id);
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(r.servers[0]!.noted).toEqual([]);
    expect(fresh(id).body).toBe(before);
  });

  it("hiç görev açılmamış alarmın resolved'ı (fixture): görev yok, not yok, hata yok", async () => {
    const fx = fixture("alerts-critical-resolved.json");
    agent.respond = () => ({ status: 200, body: fx });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(r.servers[0]!.opened).toEqual([]);
    expect(r.servers[0]!.noted).toEqual([]);
    expect(tasksFor("vlad")).toHaveLength(0);
  });
});

describe("monitor-kabul 6: warning/info görev açmaz", () => {
  it("fixture: görev yok, logged'da ikisi de, imleç ilerler", async () => {
    const fx = fixture<{ next_cursor: string; items: { severity: string; alert_id: string }[] }>("alerts-warning-info-firing.json");
    agent.respond = () => ({ status: 200, body: fx });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(tasksFor("vlad")).toHaveLength(0);
    expect(r.servers[0]!.opened).toEqual([]);
    expect(r.servers[0]!.logged.map((l) => l.severity).sort()).toEqual(fx.items.map((i) => i.severity).sort());
    expect(w.readState().servers.medialog!.cursor).toBe(fx.next_cursor);
  });

  it("vlad:'none' bastırma anahtarı: log bile yazılmaz", async () => {
    agent.upsert(alertItem({ severity: "warning", vlad: "none" }));
    agent.upsert(alertItem({ severity: "warning", vlad: "log", rule_id: "other-rule" }));
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.servers[0]!.logged).toHaveLength(1);
    expect(tasksFor("vlad")).toHaveLength(0);
  });
});

describe("monitor-kabul 16: sayfalama", () => {
  it("fixture sayfa1 (has_more) → sayfa2: ikisi de işlenir, ikinci istek sayfa1 imleciyle, son imleç sayfa2'ninki", async () => {
    const p1 = fixture<{ next_cursor: string; items: { alert_id: string }[] }>("alerts-page1-has-more.json");
    const p2 = fixture<{ next_cursor: string; items: { alert_id: string }[] }>("alerts-page2-last.json");
    agent.respond = (q) => ({ status: 200, body: q.get("cursor") === p1.next_cursor ? p2 : p1 });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    const ids = [...p1.items, ...p2.items].map((i) => i.alert_id).sort();
    expect(r.servers[0]!.fetched).toBe(ids.length);
    expect(r.servers[0]!.opened.map((o) => o.alert_id).sort()).toEqual(ids);
    expect(agent.requests[0]!.query.get("limit")).toBe(String(MONITOR_LIMITS.pageLimit));
    expect(agent.requests[1]!.query.get("cursor")).toBe(p1.next_cursor);
    expect(w.readState().servers.medialog!.cursor).toBe(p2.next_cursor);
  });

  it("sayfa tavanı: has_more hiç bitmezse page_limit hatası, en çok maxPages istek, imleç ilerlemez", async () => {
    const pageBody = { server: "medialog", epoch: "epoch-aaaaaaaa", items: [alertItem({ severity: "info" })], next_cursor: "abc", has_more: true };
    agent.respond = () => ({ status: 200, body: pageBody });
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors.map((e) => e.code)).toEqual(["page_limit"]);
    expect(r.errors[0]!.server).toBe("medialog");
    expect(agent.requests.length).toBeLessThanOrEqual(MONITOR_LIMITS.maxPages);
    expect(exitCodeOf(r)).toBe(1);
    const cur = existsSync(w.statePath) ? w.readState().servers.medialog?.cursor ?? null : null;
    expect(cur).toBeNull();
  });
});

describe("monitor-kabul: görev sel sınırı", () => {
  it(`bir çekişte en çok ${MONITOR_LIMITS.maxNewTasksPerPull} yeni görev; aşımda task_limit hatası (çıkış 1)`, async () => {
    for (let i = 0; i < MONITOR_LIMITS.maxNewTasksPerPull + 2; i++) agent.upsert(alertItem({ rule_id: `flood-${i}` }));
    const r = await pullAlerts(w.deps(medialog()));
    expect(tasksFor("vlad")).toHaveLength(MONITOR_LIMITS.maxNewTasksPerPull);
    expect(r.servers[0]!.opened).toHaveLength(MONITOR_LIMITS.maxNewTasksPerPull);
    expect(r.errors.map((e) => e.code)).toContain("task_limit");
    expect(exitCodeOf(r)).toBe(1);
  });
});

describe("monitor-kabul 11: --server ve çoklu sunucu", () => {
  it("iki sunucu: her biri kendi projesine görev açar; --server yalnız ona gider", async () => {
    const w2 = makeWorld(["vlad", "medialog"], ["medialog", "srv-b"]);
    const b = await new FakeAgent().start();
    try {
      agent.upsert(alertItem({ rule_id: "a-rule" }));
      b.upsert(alertItem({ rule_id: "b-rule" }));
      const servers = [server("medialog", agent.url, "medialog"), server("srv-b", b.url, "vlad")];
      const only = await pullAlerts(w2.deps(servers), { server: "medialog" });
      expect(only.servers.map((s) => s.id)).toEqual(["medialog"]);
      expect(b.requests).toHaveLength(0);
      expect(tasksFor("medialog")).toHaveLength(1);
      expect(tasksFor("vlad")).toHaveLength(0);
      const both = await pullAlerts(w2.deps(servers));
      expect(both.servers.map((s) => s.id).sort()).toEqual(["medialog", "srv-b"]);
      expect(tasksFor("medialog")).toHaveLength(1);
      expect(tasksFor("vlad")).toHaveLength(1);
      expect(markerLines(tasksFor("vlad")[0]!.body)[0]).toMatch(/^spc-alert: srv-b\//);
    } finally { await b.stop(); }
  });

  it("bilinmeyen --server: config hatası (çıkış 2), hiçbir ajana gidilmez", async () => {
    const r = await pullAlerts(w.deps(medialog()), { server: "yok-boyle" });
    expect(r.errors.map((e) => e.code)).toEqual(["config"]);
    expect(exitCodeOf(r)).toBe(2);
    expect(agent.requests).toHaveLength(0);
    expect(tasksFor("vlad")).toHaveLength(0);
  });

  it("bir sunucu 401 verirken diğeri işlenir; çıkış 1; durum dosyası ikisini de ayrı tutar", async () => {
    const w2 = makeWorld(["vlad"], ["medialog", "srv-b"]);
    const b = await new FakeAgent().start();
    try {
      agent.token = "baska-bir-belirtec";
      b.upsert(alertItem({ rule_id: "b-rule" }));
      const r = await pullAlerts(w2.deps([server("medialog", agent.url), server("srv-b", b.url)]));
      expect(r.errors.map((e) => [e.server, e.code])).toEqual([["medialog", "unauthorized"]]);
      expect(exitCodeOf(r)).toBe(1);
      expect(r.servers.find((s) => s.id === "srv-b")!.opened).toHaveLength(1);
      expect(r.servers.find((s) => s.id === "medialog")!.ok).toBe(false);
      expect(tasksFor("vlad")).toHaveLength(1);
    } finally { await b.stop(); }
  });
});

describe("monitor-kabul: --dry-run ve platform", () => {
  it("dry-run: görev yok, not yok, durum dosyası yok; sonuç hatasız", async () => {
    agent.upsert(alertItem());
    const r = await pullAlerts(w.deps(medialog()), { dryRun: true });
    expect(r.errors).toEqual([]);
    expect(tasksFor("vlad")).toHaveLength(0);
    expect(existsSync(w.statePath)).toBe(false);
    // dry-run'dan sonra gerçek çekiş alarmı yine görür (imleç ilerlemedi)
    const real = await pullAlerts(w.deps(medialog()));
    expect(real.servers[0]!.opened).toHaveLength(1);
  });

  it("Mac dışında pull: unsupported_platform (çıkış 2), ağ ve kb'ye dokunmaz", async () => {
    agent.upsert(alertItem());
    const r = await pullAlerts(w.deps(medialog(), { platform: "win32" }));
    expect(r.errors.map((e) => e.code)).toEqual(["unsupported_platform"]);
    expect(exitCodeOf(r)).toBe(2);
    expect(agent.requests).toHaveLength(0);
    expect(tasksFor("vlad")).toHaveLength(0);
  });
});

describe("monitor-kabul: durum dosyası izinleri", () => {
  it.skipIf(process.platform === "win32")("dizin 0700, dosya 0600", async () => {
    agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    expect(statSync(w.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(w.statePath).mode & 0o777).toBe(0o600);
  });
});
