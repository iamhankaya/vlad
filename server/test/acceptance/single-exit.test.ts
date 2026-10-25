// T9 kabul: tek çıkış matrisi. Her eylem ucu × saldırı → `executeAction` çağrısı 0 ve GitHub yazma sayacı 0; geçerli onayda tam 1.
import { afterEach, describe, expect, it } from "vitest";
import { validator } from "../helpers/openapi.ts";
import { APPROVAL_ATTACKS, ENVELOPE_ATTACKS, EXIT_ENDPOINTS, HEAD, MERGE_SHA, PARENT, REPO, T1, World, type Res } from "./single-exit.matrix.ts";

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
    expect(proof.signed_bytes_b64).toBe(ch.bytes_b64);
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

  it("createGrant: S10a gelene dek hiçbir imzalı çağrı 2xx vermez ve hiçbir şey yürütmez", async () => {
    const w = mk();
    const a = await w.phone("A");
    const ep = EXIT_ENDPOINTS.find((e) => e.operationId === "createGrant")!;
    expect(ep.implemented).toBe(false);
    for (const body of ["{}", "", "{\"x\":1}", JSON.stringify({ actions: ["merge_phase"], scope: { type: "project", ref: "widgets" }, signature: "AAAA" })]) {
      const res = await ep.fire(w, a, {}, { body });
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).not.toBe(200);
    }
    expect(w.exec).toBe(0);
    expect(w.writes).toBe(0);
  });

  // Devir (S10a) geldiğinde createGrant satırının `implemented: true` yapılıp devir negatifleri/pozitifleri (grant-*) ayrı turda eklenir.
  it.todo("createGrant: S10a — {imzasız, eşleşmemiş, hatalı imza, yanlış cihaz, iptal, session anahtarı, not_delegable kind} → devir yok; geçerli devirde tam 1 kayıt");
});
