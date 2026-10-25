// T9 kabul: rota envanteri. Her `session+approval` ya da eylem/devir ucu tek çıkış matrisinde satırlı olmak zorunda; satırsız yeni
// rota bu dosyayı kırar. Eylem ucu olmayan her rota, geçerli bir oturumla her biçimde çağrılsa da hiçbir şey yürütmez.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { call } from "./auth-kit.ts";
import { EXIT_ENDPOINTS, NON_EXIT_REASON, OPS, T1, World } from "./single-exit.matrix.ts";

const worlds: World[] = [];
const mk = () => {
  const w = new World();
  worlds.push(w);
  return w;
};
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.close();
});

const exitIds = new Set(EXIT_ENDPOINTS.map((e) => e.operationId));
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

describe("rota envanteri: sınıflandırma tam", () => {
  it("openapi'deki her uç ya matriste (eylem ucu) ya da gerekçeli 'eylem değil' listesinde; ikisi birden değil", () => {
    for (const o of OPS) {
      const inExit = exitIds.has(o.id);
      const inNon = o.id in NON_EXIT_REASON;
      expect(inExit || inNon, `${o.id} (${o.method} ${o.path}) tek çıkış matrisinde satırsız: EXIT_ENDPOINTS'e ekle ya da NON_EXIT_REASON'a gerekçesiyle yaz`).toBe(true);
      expect(inExit && inNon, `${o.id} hem eylem ucu hem 'eylem değil'`).toBe(false);
    }
  });

  it("matris ve 'eylem değil' listesinde openapi'de olmayan (artık silinmiş) uç yok", () => {
    const known = new Set(OPS.map((o) => o.id));
    for (const id of [...exitIds, ...Object.keys(NON_EXIT_REASON)]) expect(known.has(id), `${id} openapi'de yok`).toBe(true);
  });

  it("her 'eylem değil' kaydının gerekçesi dolu", () => {
    for (const [id, why] of Object.entries(NON_EXIT_REASON)) expect(why.trim().length, id).toBeGreaterThan(2);
  });

  it("her session+approval ucu matris satırlıdır (onay isteyen uç tek çıkış sayılır)", () => {
    for (const o of OPS.filter((x) => x.auth === "session+approval")) {
      // revokeDevice bilerek 'eylem değil': yalnız azaltır; matriste yerine auth-revoke.test.ts onu sınar.
      // takeoverActive aynı sınıfta: GitHub'a yazmaz, yalnız etkin VLAD kaydını devralır; imza kapısı kbsync-takeover.test.ts'te sınanır.
      if (o.id === "revokeDevice" || o.id === "takeoverActive") continue;
      expect(exitIds.has(o.id), `${o.id} session+approval ama matriste yok`).toBe(true);
    }
  });

  it("actions ve grants etiketli her yazan uç (POST/PUT/PATCH/DELETE) sınıflandırılmıştır", () => {
    for (const o of OPS.filter((x) => WRITE_METHODS.has(x.method) && x.tags.some((t) => ["actions", "grants"].includes(t)))) {
      expect(exitIds.has(o.id) || o.id in NON_EXIT_REASON, o.id).toBe(true);
    }
  });

  it("matristeki her uç openapi'deki gerçek bir rotaya karşılık gelir ve kendi sınıfında auth'u en az 'session' ister", () => {
    for (const e of EXIT_ENDPOINTS) {
      const o = OPS.find((x) => x.id === e.operationId);
      expect(o, e.operationId).toBeTruthy();
      expect(["session", "session+approval"], e.operationId).toContain(o!.auth);
    }
  });

  it("eylem ucu olarak sınıflananlar tam olarak: prepareAction, approveAction, createGrant (S10a ile genişler)", () => {
    expect([...exitIds].sort()).toEqual(["approveAction", "createGrant", "prepareAction"]);
  });
});

/** Yol parametrelerini gerçek kimliklerle doldurur. */
const fill = (path: string, actionId: string, deviceId: string) =>
  path.replace(":id", "x").replace("{id}", "x").replace("{slug}", "widgets").replace(/\{(\w+)\}/g, "x").replace("/actions/x", `/actions/${actionId}`).replace("/devices/x", `/devices/${deviceId}`);

const BODIES = ["{}", "", "{\"signature\":\"AAAA\"}", "{\"kind\":\"merge_phase\",\"task_id\":\"T20261025-84\"}", "{\"text\":\"evet\"}", "{\"answer\":\"evet\"}"];

describe("rota envanteri: eylem olmayan uçlar yürütmez", () => {
  it("geçerli oturumlu cihaz eylem ucu olmayan her rotayı her gövdeyle çağırır; executeAction 0 ve GitHub yazma 0", async () => {
    const w = mk();
    const a = await w.phone("A");
    const b = await w.phone("B");
    const ch = await w.prepared(a, T1); // canlı bir challenge var: action id'li uçlar gerçek bir hedefe çarpar
    const seen: string[] = [];
    for (const o of OPS) {
      if (exitIds.has(o.id) || o.id === "streamEvents" || o.id === "pairDevice" || o.id === "getHealth" || o.id === "revokeDevice") continue;
      const bodies = WRITE_METHODS.has(o.method) ? BODIES : [undefined];
      for (const body of bodies) {
        const res = await call(w.r, a, o.method, fill(o.path, ch.action_id, b.id), body);
        seen.push(`${o.id} ${res.statusCode}`);
        // Okuma uçları kb için `vlad` CLI'ını çağırır (test ortamında yok → 503): yanıt kodu burada konu değil, yalnız sayaçlar.
      }
    }
    await w.settle();
    expect(w.exec, seen.join(", ")).toBe(0);
    expect(w.writes).toBe(0);
  });

  it("canlı challenge varken /reject'ten sonra (reject uygulanmışsa) aynı challenge'ın geçerli onayı yürütmez", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const rj = await call(w.r, a, "POST", `/v1/actions/${ch.action_id}/reject`, "");
    await w.settle();
    const res = await w.approveValid(a, ch);
    if (rj.statusCode === 200) {
      expect(res.statusCode, res.body).not.toBe(200);
      expect(w.exec).toBe(0);
      expect(w.writes).toBe(0);
    } else {
      // reject henüz uygulanmamış (örn. 501): challenge'ı düşürmedi; bu durumda onay yasal yoldan yürür, sayaç tam 1.
      expect([501, 404], rj.body).toContain(rj.statusCode);
      expect(res.statusCode, res.body).toBe(200);
      expect(w.exec).toBe(1);
    }
  });

  it("eylem uçlarına yanlış yöntemle (GET/PUT/DELETE/PATCH) imzalı istek 2xx vermez ve hiçbir şey yürütmez", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    for (const o of OPS.filter((x) => exitIds.has(x.id))) {
      for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
        if (method === o.method) continue;
        if (OPS.some((x) => x.path === o.path && x.method === method)) continue; // aynı yolda gerçek başka uç (ör. GET /grants)
        const res = await call(w.r, a, method, fill(o.path, ch.action_id, a.id), method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ signature: w.sign(a, ch) }));
        expect(res.statusCode, `${method} ${o.path} ${res.body}`).toBeGreaterThanOrEqual(400);
      }
    }
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });

  it("onay yolunu sarmalayan varyant yollar (büyük harf, sondaki '/', çift '/', %2F, noktalı) yürütmez", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const sig = JSON.stringify({ signature: w.sign(a, ch) });
    const variants = [
      `/v1/actions/${ch.action_id}/approve/`,
      `/v1/actions/${ch.action_id}/Approve`,
      `//v1/actions/${ch.action_id}/approve`,
      `/v1/actions/${ch.action_id}%2Fapprove`,
      `/v1/actions/${ch.action_id}/./approve`,
      `/v1/actions/../actions/${ch.action_id}/approve`,
      `/v1/actions/${ch.action_id}/approve;x`,
      `/v2/actions/${ch.action_id}/approve`,
    ];
    for (const target of variants) {
      const res = await call(w.r, a, "POST", target, sig);
      expect(res.statusCode, `${target} ${res.body}`).toBeGreaterThanOrEqual(400);
    }
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });

  it("imzalı geçerli bir onay yalnızca approveAction yolundan yürür: her uç ayrı kez çağrıldığında toplam yürütme tam 1", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    for (const o of OPS) {
      if (o.id === "approveAction" || o.id === "streamEvents" || o.id === "pairDevice" || o.id === "revokeDevice" || o.id === "rejectAction") continue;
      await call(w.r, a, o.method, fill(o.path, ch.action_id, "ghost"), WRITE_METHODS.has(o.method) ? JSON.stringify({ signature: w.sign(a, ch), kind: "merge_phase", task_id: T1 }) : undefined);
    }
    expect(w.exec).toBe(0);
    expect((await w.approveValid(a, ch)).statusCode).toBe(200);
    expect(w.exec).toBe(1);
    expect(w.writes).toBe(1);
  });
});

describe("rota envanteri: statik tek çıkış", () => {
  const SRC = join(import.meta.dirname, "..", "..", "src");
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));

  it("executeAction (`.execute(`) çağrısı sunucu kaynağında yalnız actions/service.ts içinde geçer", () => {
    // S9b yürütücüyü yazar (tanımlar), çağıran yer yine yalnız ActionService olmalı. Başka dosyada `.execute(` çağrısı ikinci çıkış demektir.
    const callers = walk(SRC).filter((f) => /\.execute\(/.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
    expect(callers).toEqual(["actions/service.ts"]);
  });

  it("GitHub'a yazan yöntem adları (merge/createCheckRun/PUT/PATCH/DELETE istemcisi) yalnız yürütücü ve yazıcı modüllerinde geçer, rota/uç modüllerinde değil", () => {
    // Yazan çağrılar S9b'de `github/writer.ts` ve `actions/executor.ts` dışında olamaz; rota ve servis dosyaları bunları çağırmaz.
    const FORBIDDEN = /\b(mergePull|mergePullRequest|createCheckRun|updateCheckRun|createRef|updateRef|deleteRef|pulls\.merge|octokit)\b/;
    const ALLOWED = [/^github\//, /^actions\/executor/];
    const bad = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((rel) => !ALLOWED.some((re) => re.test(rel)))
      .filter((rel) => FORBIDDEN.test(readFileSync(join(SRC, rel), "utf8")));
    expect(bad).toEqual([]);
  });
});
