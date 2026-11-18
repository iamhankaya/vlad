// monitor-doğrulama (T20261119-23): kabul testlerinin kapsamadığı hata-avı yoklamaları (eşzamanlı çekiş, sunucu kimliği, alarm salınımı,
// iptal edilmiş görev + yeniden firing). Gerçek kaynak koruması: ajan loopback sahte sunucu, Keychain sahte, kb/durum geçici dizinde.
// `it.fails` = hata kanıtlayan test; üretim kodu düzelince "beklenmedik geçti" diye kırılır ve `it.fails` → `it` yapılır (gate yeşil kalsın diye).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pullAlerts } from "../../src/monitor/pull.js";
import { cancelTask } from "../../src/tasks/store.js";
import { FakeAgent, alertItem, fresh, makeWorld, progressOf, server, tasksFor } from "./monitor-harness.js";
import type { World } from "./monitor-harness.js";

let agent: FakeAgent;
let w: World;
beforeEach(async () => { agent = await new FakeAgent().start(); w = makeWorld(); });
afterEach(async () => { await agent.stop(); });
const medialog = () => [server("medialog", agent.url)];

describe("monitor-doğrulama: eşzamanlı çekiş (launchd çakışması / elle çalıştırma)", () => {
  // Çökme/yeniden başlama sonrası ya da elle `vlad monitor pull` 5 dk'lık tetikle çakışabilir; idempotans yarışta da tutmalı.
  // Süreç içi yoklama (aynı olay döngüsü); ayrı süreçlerin gerçek yarışı bu testle kanıtlanmaz (kb kilidi/launchd tek örnek varsayımı).
  it("aynı anda iki pullAlerts aynı alarm için tek görev açar", async () => {
    agent.upsert(alertItem());
    await Promise.all([pullAlerts(w.deps(medialog())), pullAlerts(w.deps(medialog()))]);
    expect(tasksFor("vlad")).toHaveLength(1);
  });
});

describe("monitor-doğrulama: sunucu kimliği", () => {
  // Bilinen açık nokta (T20261119-22 raporu): yanıttaki `server` yapılandırmadaki id ile karşılaştırılmıyor.
  it.fails("yanıttaki server alanı yapılandırma id'sinden farklıysa hata verir ve görev açmaz", async () => {
    agent.mutate = (b) => ({ ...b, server: "baska-sunucu" });
    agent.upsert(alertItem());
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors.length).toBeGreaterThan(0);
    expect(tasksFor("vlad")).toHaveLength(0);
  });
});

describe("monitor-doğrulama: alarm salınımı ve iptal", () => {
  it("aynı alarm kimliği resolved → yeniden firing: ikinci görev açılmaz, hata yok", async () => {
    const a = agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    agent.resolve(a.alert_id);
    await pullAlerts(w.deps(medialog()));
    agent.upsert({ ...a, state: "firing", resolved_at: null, resolve_reason: null }); // aynı kimlik tekrar firing
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(tasksFor("vlad")).toHaveLength(1);
  });

  it("iptal edilmiş görevin alarmı yeniden firing gelirse yeni görev açılmaz", async () => {
    const a = agent.upsert(alertItem());
    await pullAlerts(w.deps(medialog()));
    cancelTask(tasksFor("vlad")[0]!.data.id, "test: elle iptal");
    agent.upsert({ ...a }); // yeni seq, aynı kimlik
    const r = await pullAlerts(w.deps(medialog()));
    expect(r.errors).toEqual([]);
    expect(tasksFor("vlad")).toHaveLength(1);
  });

  it("resolved notu aynı sayfada gelen iki alarmın doğru görevine düşer (karışmaz)", async () => {
    const a = agent.upsert(alertItem({ rule_id: "rule-a" }));
    const b = agent.upsert(alertItem({ rule_id: "rule-b" }));
    await pullAlerts(w.deps(medialog()));
    agent.resolve(b.alert_id);
    await pullAlerts(w.deps(medialog()));
    const byMarker = (id: string) => tasksFor("vlad").find((t) => t.body.includes(id))!;
    expect(progressOf(fresh(byMarker(a.alert_id).data.id)).trim()).toBe("");
    expect(progressOf(fresh(byMarker(b.alert_id).data.id))).toMatch(/çözüldü/);
  });
});
