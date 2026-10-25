// T9 kabul: tek çıkış matrisi. Her eylem ucu × saldırı → `executeAction` çağrısı 0 ve GitHub yazma sayacı 0; geçerli onayda tam 1.
import { afterEach, describe, expect, it } from "vitest";
import { validator } from "../helpers/openapi.ts";
import { call } from "./auth-kit.ts";
import { APPROVAL_ATTACKS, ENVELOPE_ATTACKS, EXIT_ENDPOINTS, HEAD, MERGE_SHA, PARENT, REPO, signHighS, signRawRS, T1, World, type Phone, type Res } from "./single-exit.matrix.ts";

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
const challengeSchema = validator({ $ref: "#/components/schemas/Challenge" });
const approveSchema = validator({ $ref: "#/components/schemas/ApproveResponse" });
const codeOf = (r: Res) => r.json()?.error?.code as string | undefined;

/** Reddedilen her yanıt sözleşmenin hata şemasına uyar, 5xx değildir ve 2xx değildir. */
function expectRefusal(r: Res, status: number[], codes?: string[]) {
  expect(r.statusCode, r.body).toBeLessThan(500);
  expect(status, `${r.statusCode} ${r.body}`).toContain(r.statusCode);
  expect(errorSchema(r.json()), r.body).toEqual([]);
  if (codes) expect(codes, r.body).toContain(codeOf(r));
}

describe("tek çıkış matrisi: zarf saldırıları × her eylem ucu", () => {
  for (const ep of EXIT_ENDPOINTS) {
    for (const atk of ENVELOPE_ATTACKS) {
      it(`${ep.operationId}: ${atk.title} → ${atk.status.join("/")}; executeAction 0, GitHub yazma 0`, async () => {
        const w = mk();
        const a = await w.phone("A");
        const s = await ep.setup(w, a);
        const res = await atk.run(w, ep, a, s);
        expectRefusal(res, atk.status, atk.codes);
        await w.settle();
        expect(w.exec).toBe(0);
        expect(w.writes).toBe(0);
      });
    }
  }
});

describe("tek çıkış matrisi: approveAction onay saldırıları", () => {
  for (const atk of APPROVAL_ATTACKS) {
    it(`approveAction: ${atk.title} → ${atk.status.join("/")}; executeAction 0, GitHub yazma 0${atk.survives ? "; yasal onay sonra yine çalışır" : "; challenge ölü kalır"}`, async () => {
      const w = mk();
      const a = await w.phone("A");
      const ch = await w.prepared(a, T1);
      const res = await atk.run(w, a, ch);
      expectRefusal(res, atk.status, atk.codes);
      await w.settle();
      expect(w.exec).toBe(0);
      expect(w.writes).toBe(0);

      const retry = await w.approveValid(a, ch);
      if (atk.survives) {
        // Saldırı yasal challenge'ı yakmadı (yalnız kendi isteği reddedildi): meşru onay tam 1 yürütme verir.
        expect(retry.statusCode, retry.body).toBe(200);
        expect(w.exec).toBe(1);
        expect(w.writes).toBe(1);
      } else {
        // Ölü challenge geçerli imzayla bile yeniden canlanmaz.
        expect(retry.statusCode, retry.body).not.toBe(200);
        expect(w.exec).toBe(0);
        expect(w.writes).toBe(0);
      }
    });
  }

  it("approveAction: 5 hatalı imzadan sonra 6. istek geçerli imzayla bile yürütmez (deneme sınırı) ve yürütme 0 kalır", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    for (let i = 0; i < 8; i++) await w.approve(a, ch.action_id, { signature: "AAAA" });
    const res = await w.approveValid(a, ch);
    expect(res.statusCode, res.body).not.toBe(200);
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });
});

describe("tek çıkış matrisi: geçerli onayda tam 1 yürütme", () => {
  it("approveAction: geçerli approval imzasıyla tam 1 executeAction ve tam 1 GitHub yazması; alanlar imzalanan challenge'dan gelir", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const res = await w.approveValid(a, ch);
    expect(res.statusCode, res.body).toBe(200);
    expect(approveSchema(res.json()), res.body).toEqual([]);
    expect(res.json()).toEqual({ status: "executed", result: { kind: "merge_phase", repo: REPO, pr: 42, head_sha: HEAD, merge_sha: MERGE_SHA } });
    expect(w.exec).toBe(1);
    expect(w.writes).toBe(1);
    expect(w.mergeWrites).toEqual([`merge #42 sha=${HEAD}`]);

    const { action, proof } = w.execCalls[0]!;
    expect(action).toEqual({ action_id: ch.action_id, kind: "merge_phase", repo: REPO, pr: 42, base: `vlad/${PARENT}`, head_sha: HEAD, task: T1 });
    expect(proof.kind).toBe("device");
    expect(proof.device_id).toBe(a.id);
    expect(proof.kind === "device" && proof.signed_bytes_b64).toBe(ch.bytes_b64);
  });

  it("approveAction: aynı challenge'a ikinci onay (yeni zarf) tek yürütme bırakır", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const first = await w.approveValid(a, ch);
    const second = await w.approveValid(a, ch);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(w.exec).toBe(1);
    expect(w.writes).toBe(1);
  });

  it("approveAction: geçerli onay isteğinin aynı baytlarla yeniden gönderimi (zarf tekrarı) 401 alır; yürütme 1 kalır", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, T1);
    const body = JSON.stringify({ signature: w.sign(a, ch) });
    const headers = a.headers(w.clock, "POST", `/v1/actions/${ch.action_id}/approve`, body);
    const send = () => w.r.app.inject({ method: "POST", url: `/v1/actions/${ch.action_id}/approve`, headers: { ...headers, "content-type": "application/json" }, payload: body });
    expect((await send()).statusCode).toBe(200);
    const replay = await send();
    expect(replay.statusCode, replay.body).toBe(401);
    expect(w.exec).toBe(1);
    expect(w.writes).toBe(1);
  });

  it("approveAction: kök görev merge_final olarak yürür (taban kartın varsayılan dalı), tam 1 yürütme", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ch = await w.prepared(a, "T20261025-86");
    expect(ch.fields.kind).toBe("merge_final");
    expect(ch.fields.base).toBe("main");
    const res = await w.approveValid(a, ch);
    expect(res.statusCode, res.body).toBe(200);
    expect(w.exec).toBe(1);
    expect(w.execCalls[0]!.action.kind).toBe("merge_final");
  });

  it("prepareAction: geçerli çağrı sözleşmeye uygun challenge verir ama hiçbir şey yürütmez (kaç kez çağrılırsa çağrılsın)", async () => {
    const w = mk();
    const a = await w.phone("A");
    for (let i = 0; i < 4; i++) {
      const res = await w.prepare(a, T1);
      expect(res.statusCode, res.body).toBe(200);
      expect(challengeSchema(res.json()), res.body).toEqual([]);
      expect(res.json().fields.head_sha).toBe(HEAD);
      expect(res.json().fields.task).toBe(T1);
    }
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });

  it("createGrant: uç uygulanmış; hiçbir imzalı çağrı (hatalı/boş gövde dahil) yürütmez, devir oluşturmak yürütme sayılmaz", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ep = EXIT_ENDPOINTS.find((e) => e.operationId === "createGrant")!;
    expect(ep.implemented).toBe(true);
    for (const body of ["{}", "", "{\"x\":1}", JSON.stringify({ actions: ["merge_phase"], scope: { type: "project", ref: "widgets" }, signature: "AAAA" })]) {
      const res = await ep.fire(w, a, {}, { body });
      expect(res.statusCode, res.body).toBe(400);
      expectRefusal(res, [400], ["bad_request"]);
    }
    expect(w.kb.added).toEqual([]);
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });

  describe("createGrant: devir negatifleri → devir yok, yürütme 0", () => {
    const grantsOf = async (w: World, a: Awaited<ReturnType<World["phone"]>>) => (await call(w.r, a, "GET", "/v1/grants")).json().grants as unknown[];
    const NEG: { id: string; title: string; status: number[]; codes: string[]; body: (w: World, a: Phone, b: Phone) => unknown }[] = [
      { id: "wrong-key", title: "session anahtarıyla imzalı", status: [422], codes: ["grant_invalid"], body: (w, a) => w.grantBody(a, {}, "session") },
      { id: "other-device", title: "başka cihazın approval anahtarıyla imzalı (yanlış cihaz)", status: [422], codes: ["grant_invalid"], body: (w, a, b) => w.grantBody(b) },
      { id: "garbage", title: "çöp imza", status: [422], codes: ["grant_invalid"], body: (w, a) => w.grantBody(a, { signature: "AAAA" }) },
      { id: "high-s", title: "yüksek-S imza", status: [422], codes: ["grant_invalid"], body: (w, a) => w.grantBody(a, {}, "approval", signHighS) },
      { id: "raw-rs", title: "ham r||s imza", status: [422], codes: ["grant_invalid"], body: (w, a) => w.grantBody(a, {}, "approval", signRawRS) },
      { id: "tampered", title: "imzadan sonra max_uses yükseltildi", status: [422], codes: ["grant_invalid"], body: (w, a) => ({ ...w.grantBody(a), max_uses: 99 }) },
      { id: "scope-widened", title: "imzadan sonra kapsam genişletildi", status: [422], codes: ["grant_invalid"], body: (w, a) => ({ ...w.grantBody(a), scope: { type: "project", ref: "other" } }) },
      ...["tag_release", "publish", "delete", "security", "scope_change"].map((k) => ({
        id: `not-delegable-${k}`, title: `devredilemez eylem ${k} (doğru imzayla bile)`, status: [422], codes: ["not_delegable"], body: (w: World, a: Phone) => w.grantBody(a, { action: k }),
      })),
      { id: "no-ci-green", title: "koşullar ci_green içermiyor", status: [400], codes: ["bad_request"], body: (w, a) => w.grantBody(a, { conditions: ["codex_clear"] }) },
      { id: "over-30-days", title: "30 günden uzun", status: [422], codes: ["grant_invalid"], body: (w, a) => w.grantBody(a, { expires: new Date(w.clock.t + 31 * 86_400_000).toISOString() }) },
      { id: "device-id-in-body", title: "gövdede device_id (cihaz yalnız zarftan bilinir)", status: [400], codes: ["bad_request"], body: (w, a) => ({ ...w.grantBody(a), device_id: a.id }) },
    ];
    for (const n of NEG) {
      it(`${n.id}: ${n.title} → ${n.status.join("/")}; devir kaydı yok, executeAction 0, GitHub yazma 0`, async () => {
        const w = mk();
        const a = await w.phone("A");
        const b = await w.phone("B");
        const res = await w.postGrant(a, n.body(w, a, b));
        expectRefusal(res, n.status, n.codes);
        await w.settle();
        expect(w.kb.added).toEqual([]);
        expect(await grantsOf(w, a)).toEqual([]);
        expect(w.exec).toBe(0);
        expect(w.writes).toBe(0);
        // devir olmadığından kart beklemeye devam eder: görev tetiklense de yürütülmez
        expect(await w.r.app.vladGrants!.tryTask(T1)).toBeNull();
        expect(w.exec).toBe(0);
      });
    }

    it("iptal edilmiş cihazın geçerli imzalı devri → 401, devir yok", async () => {
      const w = mk();
      const a = await w.phone("A");
      const b = await w.phone("B");
      const body = w.grantBody(a);
      expect((await w.revoke(b, a.id)).statusCode).toBe(200);
      await w.settle();
      const res = await w.postGrant(a, body);
      expectRefusal(res, [401], ["unauthorized", "device_revoked"]);
      expect(w.kb.added).toEqual([]);
      expect(await grantsOf(w, b)).toEqual([]);
      expect(w.exec).toBe(0);
    });

    it("devir gövdesi başka bir zarfa taşınamaz: A'nın imzalı gövdesini B kendi zarfıyla gönderirse devir B'ye değil kimseye yazılmaz", async () => {
      const w = mk();
      const a = await w.phone("A");
      const b = await w.phone("B");
      const res = await w.postGrant(b, w.grantBody(a));
      expectRefusal(res, [422], ["grant_invalid"]);
      expect(w.kb.added).toEqual([]);
      expect(w.exec).toBe(0);
    });

    it("geçerli devirde tam 1 kayıt; aynı gövdenin yeniden gönderimi ikinci kayıt üretmez; hiçbir şey yürümez", async () => {
      const w = mk();
      const a = await w.phone("A");
      const body = w.grantBody(a);
      const res = await w.postGrant(a, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ id: "G-001" });
      expect(w.kb.added).toHaveLength(1);
      expect(w.kb.added[0]).toMatchObject({ id: "G-001", device_id: a.id, signature: body.signature });
      expect(await grantsOf(w, a)).toHaveLength(1);
      const again = await w.postGrant(a, body);
      expect(again.statusCode, again.body).toBe(409);
      expect(w.kb.added).toHaveLength(1);
      expect(await grantsOf(w, a)).toHaveLength(1);
      expect(w.exec).toBe(0);
      expect(w.writes).toBe(0);
    });

    it("devirle yürüyen eylem de tek çıkıştan geçer: executeAction tam 1, kanıt türü grant, alanlar görevden/GitHub'dan; kapsam dışı ve iptal edilmiş devir yürütmez", async () => {
      const w = mk();
      const a = await w.phone("A");
      // kapsam dışı devir: yürütme yok
      expect((await w.postGrant(a, w.grantBody(a, { id: "G-001", scope: { type: "project", ref: "other" } }))).statusCode).toBe(200);
      expect(await w.r.app.vladGrants!.tryTask(T1)).toBeNull();
      expect(w.exec).toBe(0);
      // iptal edilmiş devir: yürütme yok
      expect((await w.postGrant(a, w.grantBody(a, { id: "G-002" }))).statusCode).toBe(200);
      expect((await call(w.r, a, "DELETE", "/v1/grants/G-002")).statusCode).toBe(200);
      expect(await w.r.app.vladGrants!.tryTask(T1)).toBeNull();
      expect(w.exec).toBe(0);
      expect(w.writes).toBe(0);
      // geçerli devir: tek çıkış, tam 1 kez
      expect((await w.postGrant(a, w.grantBody(a, { id: "G-003" }))).statusCode).toBe(200);
      const out = await w.r.app.vladGrants!.tryTask(T1);
      expect(out).toEqual({ status: "executed", result: { kind: "merge_phase", repo: REPO, pr: 42, head_sha: HEAD, merge_sha: MERGE_SHA } });
      expect(w.exec).toBe(1);
      expect(w.writes).toBe(1);
      expect(w.execCalls[0]!.action).toMatchObject({ kind: "merge_phase", repo: REPO, pr: 42, base: `vlad/${PARENT}`, head_sha: HEAD, task: T1 });
      expect(w.execCalls[0]!.proof).toMatchObject({ kind: "grant", grant_id: "G-003", device_id: a.id });
      // aynı görev ikinci kez yürümez (sahte yürütücü görevi `done` yapmadığından PR'ın birleşmiş olması engeller)
      await expect(w.r.app.vladGrants!.tryTask(T1)).rejects.toMatchObject({ details: { reason: "pr_merged" } });
      expect(w.exec).toBe(1);
      expect(w.writes).toBe(1);
    });
  });
});
