// T9 kabul: prepare ile approve arasında (ve approve sürerken) dünya değişir → yazma 0; eşzamanlı onaylar → tek yürütme.
// Dünya (GitHub, görev, proje kartı, saat, cihaz) sahte kaynaklardan değiştirilir; istemci tarafı her seferinde GEÇERLİ imza yollar.
import { afterEach, describe, expect, it } from "vitest";
import { ActionError } from "../../src/actions/service.ts";
import { validator } from "../helpers/openapi.ts";
import { call } from "./auth-kit.ts";
import { HEAD, HEAD_MOVED, T1, T3, World, sha40, type Res } from "./single-exit.matrix.ts";

const worlds: World[] = [];
const mk = (o?: ConstructorParameters<typeof World>[0]) => {
  const w = new World(o);
  worlds.push(w);
  return w;
};
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.close();
});

const errorSchema = validator({ $ref: "#/components/schemas/Error" });
const codeOf = (r: Res) => r.json()?.error?.code as string | undefined;

/** prepare → `mutate` → geçerli imzalı approve; yazma sayaçları 0, yanıt `status` içinde ve sözleşme hata şemasında. */
async function refused(mutate: (w: World) => void | Promise<void>, status: number[], codes?: string[], task = T1) {
  const w = mk();
  const a = await w.phone("A");
  const ch = await w.prepared(a, task);
  await mutate(w);
  const res = await w.approveValid(a, ch);
  await w.settle();
  expect(status, `${res.statusCode} ${res.body}`).toContain(res.statusCode);
  expect(errorSchema(res.json()), res.body).toEqual([]);
  if (codes) expect(codes, res.body).toContain(codeOf(res));
  expect(w.exec).toBe(0);
  expect(w.writes).toBe(0);
  return { w, a, ch, res };
}

describe("TOCTOU: prepare ile approve arasında GitHub değişir", () => {
  it("head değişti → 409 head_moved; yazma 0", async () => {
    await refused((w) => void (w.pull().head.sha = HEAD_MOVED), [409], ["head_moved"]);
  });

  it("PR kapandı → 409 not_mergeable; yazma 0", async () => {
    await refused((w) => void (w.pull().state = "closed"), [409], ["not_mergeable"]);
  });

  it("PR başka yoldan birleştirildi → 409; yazma 0", async () => {
    await refused((w) => {
      w.pull().merged = true;
      w.pull().state = "closed";
    }, [409], ["not_mergeable"]);
  });

  it("PR silindi/bulunamıyor (404) → 409; yazma 0", async () => {
    await refused((w) => void w.gh.missing.add(42), [409], ["not_mergeable"]);
  });

  it("PR taslağa çevrildi → 409; yazma 0", async () => {
    await refused((w) => void (w.pull().draft = true), [409], ["not_mergeable"]);
  });

  it("PR tabanı değişti → 409; yazma 0", async () => {
    await refused((w) => void (w.pull().base.ref = "master"), [409], ["not_mergeable", "head_moved"]);
  });

  it("PR'ın head deposu fork'a döndü → 409; yazma 0", async () => {
    await refused((w) => void (w.pull().head.repo = "mallory/widgets"), [409], ["not_mergeable"]);
  });

  it("PR'ın head dalı başka bir dala işaret ediyor (vlad/<görev> değil) → 409; yazma 0", async () => {
    await refused((w) => void (w.pull().head.ref = "feature/other"), [409], ["not_mergeable"]);
  });

  for (const state of ["dirty", "behind", "blocked", "unstable", "draft"]) {
    it(`mergeable_state=${state} → 409; yazma 0`, async () => {
      await refused((w) => {
        w.pull().mergeable_state = state;
        if (state === "dirty") w.pull().mergeable = false;
      }, [409], ["not_mergeable"]);
    });
  }

  it("mergeable hesaplanmıyor (null) → en fazla birkaç yeniden okumadan sonra 409; yazma 0", async () => {
    const { w } = await refused((w) => void ((w.pull().mergeable = null), (w.pull().mergeable_state = "unknown")), [409], ["not_mergeable"]);
    expect(w.gh.calls.filter((c) => c === "getPull").length).toBeLessThanOrEqual(1 + 5); // prepare + sınırlı yeniden deneme, sonsuz döngü yok
  });

  it("CI kırmızıya döndü → 422 ci_not_green; yazma 0", async () => {
    await refused((w) => void (w.gh.runs = [{ name: "gate", status: "completed", conclusion: "failure" }]), [422], ["ci_not_green"]);
  });

  it("CI yeniden koşuyor (bitmemiş) → 422; yazma 0", async () => {
    await refused((w) => void (w.gh.runs = [{ name: "gate", status: "in_progress", conclusion: null }]), [422], ["ci_not_green"]);
  });

  it("CI sinyali kayboldu (hiç koşu/durum yok) → 422; yazma 0", async () => {
    await refused((w) => {
      w.gh.runs = [];
      w.gh.status = { state: "pending", total_count: 0 };
    }, [422], ["ci_not_green"]);
  });

  it("yalnız atlanmış (skipped) koşular 'yeşil' sayılmaz → 422; yazma 0", async () => {
    await refused((w) => {
      w.gh.runs = [{ name: "gate", status: "completed", conclusion: "skipped" }];
      w.gh.status = { state: "pending", total_count: 0 };
    }, [422], ["ci_not_green"]);
  });

  it("GitHub okunamıyor (hata) → 503 ve yazma 0; hata kaynak kapanınca aynı imza yeniden çalışır (challenge yanmaz)", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const orig = w.gh.getPull.bind(w.gh);
    w.gh.getPull = async () => {
      throw new Error("ağ kesildi");
    };
    const down = await w.approveValid(a, ch);
    expect(down.statusCode, down.body).toBe(503);
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
    w.gh.getPull = orig;
    const up = await w.approveValid(a, ch);
    expect(up.statusCode, up.body).toBe(200);
    expect(w.exec).toBe(1);
  });

  it("reddedilen onaydan sonra PR düzelse bile aynı challenge yeniden canlanmaz (başarısız = son durum); yeni prepare gerekir", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    w.pull().head.sha = HEAD_MOVED;
    expect((await w.approveValid(a, ch)).statusCode).toBe(409);
    w.pull().head.sha = HEAD;
    const again = await w.approveValid(a, ch);
    expect(again.statusCode, again.body).not.toBe(200);
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });
});

describe("TOCTOU: görev ve proje kartı değişir", () => {
  it("görev awaiting_approval'dan çıktı (iptal edildi) → 409; yazma 0", async () => {
    await refused((w) => void (w.tasks.get(T1)!.state = "cancelled"), [409, 404], ["bad_request", "not_mergeable"]);
  });

  it("görev değişiklik istendi durumuna döndü → 409; yazma 0", async () => {
    await refused((w) => void (w.tasks.get(T1)!.state = "changes_requested"), [409], ["bad_request", "not_mergeable"]);
  });

  it("görev zaten tamamlandı/birleşti (merged) → 409; yazma 0", async () => {
    await refused((w) => void (w.tasks.get(T1)!.state = "merged"), [409], ["bad_request", "not_mergeable"]);
  });

  it("görev dosyası kayboldu → 404/409; yazma 0", async () => {
    await refused((w) => void w.tasks.delete(T1), [404, 409], ["bad_request", "not_mergeable"]);
  });

  it("görevin PR'ı başka bir PR'a çevrildi → 409; yazma 0", async () => {
    await refused((w) => void (w.tasks.get(T1)!.pr!.number = 99), [409], ["bad_request", "not_mergeable"]);
  });

  it("görevin kayıtlı tabanı değişti → 409; yazma 0", async () => {
    await refused((w) => void (w.tasks.get(T1)!.pr!.base = "main"), [409], ["bad_request", "not_mergeable"]);
  });

  it("görevin PR deposu başka bir depoya çevrildi → 409; yazma 0", async () => {
    await refused((w) => void (w.tasks.get(T1)!.pr!.repo = "mallory/widgets"), [409], ["bad_request", "not_mergeable"]);
  });

  it("proje kartının repo'su değişti → 409; yazma 0", async () => {
    await refused((w) => void (w.projects.get("widgets")!.repo = "acme/other"), [409], ["bad_request", "not_mergeable"]);
  });

  it("proje kartından repo alanı kalktı → 409; yazma 0", async () => {
    await refused((w) => void delete w.projects.get("widgets")!.repo, [409], ["bad_request", "not_mergeable"]);
  });

  it("proje kartı silindi → 409; yazma 0", async () => {
    await refused((w) => void w.projects.delete("widgets"), [409], ["bad_request", "not_mergeable"]);
  });

  // KIRMIZI (bilerek): approve yalnız repo'yu karttan yeniden doğrular; merge_final'ın "kartın varsayılan dalına" kuralı prepare'de var, approve'da yok.
  it("merge_final: kartın varsayılan dalı değişti (taban artık eşleşmiyor) → 409; yazma 0", async () => {
    await refused((w) => void (w.projects.get("widgets")!.default_branch = "trunk"), [409], ["bad_request", "not_mergeable", "head_moved"], T3);
  });

  it("kb okunamıyor (görev kaynağı hata verir) → 503 ve yazma 0; kaynak dönünce aynı imza yeniden çalışır", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const saved = w.tasks.get(T1)!;
    w.tasks.get = () => {
      throw new Error("kb okunamadı");
    };
    const down = await w.approveValid(a, ch);
    expect([503, 409]).toContain(down.statusCode);
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
    w.tasks.get = Map.prototype.get.bind(w.tasks);
    w.tasks.set(T1, saved);
    if (down.statusCode === 503) {
      expect((await w.approveValid(a, ch)).statusCode).toBe(200);
      expect(w.exec).toBe(1);
    }
  });
});

describe("TOCTOU: cihaz iptali", () => {
  it("prepare'den sonra cihaz iptal edilir → onay 401/410, yazma 0 (iptal edilen cihazın imzası geçerli olsa bile)", async () => {
    const w = mk();
    const a = await w.phone("A");
    const b = await w.phone("B");
    const ch = await w.prepared(a, T1);
    expect((await w.revoke(b, a.id)).statusCode).toBe(200);
    await w.settle();
    const res = await w.approveValid(a, ch);
    expect([401, 410]).toContain(res.statusCode);
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });

  it("başka cihazın iptali bu cihazın challenge'ını öldürmez (iptal yalnız hedef cihaza)", async () => {
    const w = mk();
    const a = await w.phone("A");
    const b = await w.phone("B");
    const c = await w.phone("C");
    const ch = await w.prepared(a, T1);
    expect((await w.revoke(b, c.id)).statusCode).toBe(200);
    await w.settle();
    expect((await w.approveValid(a, ch)).statusCode).toBe(200);
    expect(w.exec).toBe(1);
  });

  it("GitHub okunurken (onay sürerken) cihaz iptal edilir → yürütücüye girmeden 410/401; yazma 0", async () => {
    const w = mk();
    const a = await w.phone("A");
    const b = await w.phone("B");
    const ch = await w.prepared(a, T1);
    const hold = w.gh.block("getCombinedStatus");
    const inflight = w.approveValid(a, ch);
    await hold.entered;
    expect((await w.revoke(b, a.id)).statusCode).toBe(200);
    hold.release();
    const res = await inflight;
    await w.settle();
    expect(res.statusCode, res.body).not.toBe(200);
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });

  it("yürütme sürerken cihaz iptal edilir → yürütme tam 1 kez bitmiş sayılır, ikinci yürütme yok; iptalli cihazın yeniden denemesi 401", async () => {
    const w = mk();
    const a = await w.phone("A");
    const b = await w.phone("B");
    const ch = await w.prepared(a, T1);
    const hold = w.holdExec();
    const inflight = w.approveValid(a, ch);
    await hold.entered;
    expect((await w.revoke(b, a.id)).statusCode).toBe(200);
    hold.release();
    const res = await inflight;
    await w.settle();
    // İmza iptalden ÖNCE kabul edildi ve çıkışa girildi: sonuç ya tamamlanmış yürütmedir ya da temiz bir ret; hiçbir halde çift yürütme yok.
    expect([200, 401, 410, 409]).toContain(res.statusCode);
    expect(w.exec).toBe(1);
    expect(w.writes).toBeLessThanOrEqual(1);
    const retry = await w.approveValid(a, ch);
    expect(retry.statusCode, retry.body).toBe(401);
    expect(w.exec).toBe(1);
  });

  it("onay ile iptal yarışı (Promise.all) → yürütme en fazla 1; iptal sonrası hiçbir onay yürütmez", async () => {
    const w = mk();
    const a = await w.phone("A");
    const b = await w.phone("B");
    const ch = await w.prepared(a, T1);
    const [ap, rv] = await Promise.all([w.approveValid(a, ch), w.revoke(b, a.id)]);
    await w.settle();
    expect(rv.statusCode).toBe(200);
    expect(ap.statusCode).toBeLessThan(500);
    expect(w.exec).toBeLessThanOrEqual(1);
    const before = w.exec;
    const after = await w.approveValid(a, ch);
    expect(after.statusCode, after.body).not.toBe(200); // iptalli cihaz hiçbir yanıtta yeni yürütme üretmez
    expect(w.exec).toBe(before);
  });
});

describe("TOCTOU: saat", () => {
  it("sunucu saati geri gider → challenge ölür (410), yazma 0; saat ilerleyince de canlanmaz", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const t0 = w.clock.t;
    w.clock.t = t0 - 5_000;
    const back = await w.approveValid(a, ch);
    await w.settle();
    expect(back.statusCode, back.body).toBe(410);
    expect(codeOf(back)).toBe("expired");
    w.clock.t = t0 + 1_000; // challenge'ın yaşam penceresi içinde, eski "şimdi"nin ilerisi
    const forward = await w.approveValid(a, ch);
    await w.settle();
    expect(forward.statusCode, forward.body).toBe(410);
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });

  it("saat geri gitti ve yeni prepare alındı → yeni challenge çalışır, eskisi ölü kalır", async () => {
    const w = mk();
    const a = await w.phone("A");
    const old = await w.prepared(a, T1);
    w.clock.t -= 30_000;
    await w.settle();
    expect((await w.approveValid(a, old)).statusCode).toBe(410);
    await w.settle();
    const fresh = await w.prepared(a, T1);
    expect((await w.approveValid(a, old)).statusCode).toBe(410);
    expect((await w.approveValid(a, fresh)).statusCode).toBe(200);
    expect(w.exec).toBe(1);
    expect(w.execCalls[0]!.action.action_id).toBe(fresh.action_id);
  });

  it("exp sınırı: tam 60. saniyede onay reddedilir (410), yazma 0", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    w.clock.t = ch.exp * 1000; // now >= exp
    const res = await w.approveValid(a, ch);
    expect(res.statusCode, res.body).toBe(410);
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });

  it("exp'ten 1 ms önce onay kabul edilir (sınırın iki yanı)", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    w.clock.t = ch.exp * 1000 - 1;
    const res = await w.approveValid(a, ch);
    expect(res.statusCode, res.body).toBe(200);
    expect(w.exec).toBe(1);
  });
});

describe("TOCTOU: eşzamanlılık", () => {
  it("aynı challenge'a 8 eşzamanlı onay (farklı zarflar, Promise.all) → tam 1 executeAction ve 1 GitHub yazması; 5xx yok", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const hold = w.holdExec(); // yürütme tutulurken diğer istekler kilitte beklemek zorunda
    const all = Array.from({ length: 8 }, () => w.approveValid(a, ch));
    await hold.entered;
    hold.release();
    const rs = await Promise.all(all);
    expect(rs.filter((r) => r.statusCode >= 500).map((r) => r.body)).toEqual([]);
    expect(rs.some((r) => r.statusCode === 200)).toBe(true);
    for (const r of rs.filter((x) => x.statusCode === 200)) expect(r.json().result.head_sha).toBe(HEAD);
    expect(w.exec).toBe(1);
    expect(w.writes).toBe(1);
  });

  it("eşzamanlı 8 onay (tutma yok) → tam 1 yürütme", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const rs = await Promise.all(Array.from({ length: 8 }, () => w.approveValid(a, ch)));
    expect(rs.filter((r) => r.statusCode >= 500).map((r) => r.body)).toEqual([]);
    expect(w.exec).toBe(1);
    expect(w.writes).toBe(1);
  });

  it("yürütme sürerken gelen ikinci onay ikinci yürütme başlatmaz; ilk bitince saklı sonucu döner", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const hold = w.holdExec();
    const first = w.approveValid(a, ch);
    await hold.entered;
    const second = w.approveValid(a, ch);
    hold.release();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    expect(w.exec).toBe(1);
  });

  it("iki cihaz aynı PR için challenge alır; biri onaylar (PR birleşir) → diğerinin geçerli onayı yürütmez", async () => {
    const w = mk();
    const a = await w.phone("A");
    const b = await w.phone("B");
    const cha = await w.prepared(a, T1);
    const chb = await w.prepared(b, T1);
    const ra = await w.approveValid(a, cha);
    expect(ra.statusCode, ra.body).toBe(200);
    const rb = await w.approveValid(b, chb);
    expect(rb.statusCode, rb.body).toBe(409);
    expect(w.exec).toBe(1);
    expect(w.writes).toBe(1);
  });

  it("iki cihazın challenge'ları eşzamanlı onaylanır → PR bir kez birleşir (tek yürütme)", async () => {
    const w = mk();
    const a = await w.phone("A");
    const b = await w.phone("B");
    const cha = await w.prepared(a, T1);
    const chb = await w.prepared(b, T1);
    const [ra, rb] = await Promise.all([w.approveValid(a, cha), w.approveValid(b, chb)]);
    expect([ra.statusCode, rb.statusCode].filter((s) => s === 200).length, `${ra.body} | ${rb.body}`).toBe(1);
    expect(w.exec).toBe(1);
    expect(w.writes).toBe(1);
  });

  it("aynı cihaz yeniden prepare eder → eski challenge'ın geçerli imzası yürütmez, yeni olan tam 1 kez yürütür", async () => {
    const w = mk();
    const a = await w.phone("A");
    const first = await w.prepared(a, T1);
    const second = await w.prepared(a, T1);
    await w.settle();
    expect((await w.approveValid(a, first)).statusCode).toBe(410);
    expect(w.exec).toBe(0);
    expect((await w.approveValid(a, second)).statusCode).toBe(200);
    expect(w.exec).toBe(1);
  });

  it("onay sürerken aynı cihazın yeni prepare'i gelir → yürütme en fazla 1; eski challenge ikinci kez yürümez", async () => {
    const w = mk();
    const a = await w.phone("A");
    const first = await w.prepared(a, T1);
    const hold = w.gh.block("getCombinedStatus");
    const inflight = w.approveValid(a, first);
    await hold.entered;
    const prep = w.prepare(a, T1);
    hold.release();
    const [ap, pr] = await Promise.all([inflight, prep]);
    await w.settle();
    expect(ap.statusCode).toBeLessThan(500);
    expect(pr.statusCode).toBeLessThan(500);
    expect(w.exec).toBeLessThanOrEqual(1);
    const second = pr.statusCode === 200 ? (pr.json() as { action_id: string; bytes_b64: string }) : null;
    if (second) {
      const r = await w.approveValid(a, second as any);
      // PR zaten birleştiyse (ilk onay kazandıysa) ikinci challenge asla yürümez.
      if (w.exec === 1 && w.mergeWrites.length === 1 && r.statusCode === 200) expect(w.execCalls.map((c) => c.action.action_id)).toHaveLength(1);
    }
    expect(w.exec).toBeLessThanOrEqual(1);
    expect(w.writes).toBeLessThanOrEqual(1);
  });

  it("yürütme sürerken challenge /reject edilir → yürütme çifte olmaz (en fazla 1); sonrasında hiçbir onay yeni yürütme üretmez", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const hold = w.holdExec();
    const inflight = w.approveValid(a, ch);
    await hold.entered;
    await call(w.r, a, "POST", `/v1/actions/${ch.action_id}/reject`, "");
    hold.release();
    const res = await inflight;
    await w.settle();
    expect(res.statusCode).toBeLessThan(500);
    expect(w.exec).toBe(1);
    await w.approveValid(a, ch);
    expect(w.exec).toBe(1);
    expect(w.writes).toBe(1);
  });

  it("yürütme sürerken görev iptal edilir → yürütme çifte olmaz; görev iptalinden sonra yeni challenge alınamaz", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const hold = w.holdExec();
    const inflight = w.approveValid(a, ch);
    await hold.entered;
    w.tasks.get(T1)!.state = "cancelled";
    hold.release();
    await inflight;
    await w.settle();
    expect(w.exec).toBe(1);
    expect((await w.prepare(a, T1)).statusCode).toBeGreaterThanOrEqual(400);
    expect(w.exec).toBe(1);
  });
});

describe("TOCTOU: yürütücü hatası ve tek yürütme", () => {
  it("yürütücü hata verir → onay 5xx değil temiz hata; challenge 'başarısız' olur ve aynı imza yeniden DENENMEZ (çift birleştirme yok)", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    w.execFail = new Error("GitHub 500");
    const res = await w.approveValid(a, ch);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(errorSchema(res.json()), res.body).toEqual([]);
    expect(w.exec).toBe(1);
    w.execFail = null;
    const retry = await w.approveValid(a, ch);
    expect(retry.statusCode, retry.body).not.toBe(200);
    expect(w.exec).toBe(1);
    expect(w.writes).toBe(0);
  });

  it("yürütücü head_moved ActionError'ı atarsa (GitHub merge sha= reddetti) kod olduğu gibi 409 head_moved döner, yazma 0", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    w.execFail = new ActionError(409, "head_moved", "head_moved");
    const res = await w.approveValid(a, ch);
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe("head_moved");
    expect(w.writes).toBe(0);
  });

  it("yürütücü her zaman İMZALANAN head SHA ile çağrılır: okumalar arasında head değişse bile canlı SHA'ya kaymaz (S9b merge sha= ile sabitler)", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const hold = w.gh.block("getCombinedStatus");
    const inflight = w.approveValid(a, ch);
    await hold.entered;
    w.pull().head.sha = sha40("d"); // son okumadan sonra dal ilerledi
    hold.release();
    const res = await inflight;
    expect(res.statusCode).toBeLessThan(500);
    // Ya reddedilir (yürütme 0) ya da yürütücü imzalanan SHA ile çağrılır; canlı SHA'ya göre birleştirme asla.
    for (const c of w.execCalls) expect(c.action.head_sha).toBe(HEAD);
    for (const m of w.mergeWrites) expect(m).toContain(`sha=${HEAD}`);
    expect(w.exec).toBeLessThanOrEqual(1);
  });
});
