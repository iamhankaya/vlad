// T11 kabul: `action_request` ve `by_device`. Sohbet/kart yolu yalnız KART üretir; yürütme için imzalı prepare → approve zinciri şarttır.
// `by_device` yalnız doğrulanmış zarfın cihaz kimliğinden gelir; istemcinin gövdesindeki alan ne olursa olsun yok sayılmaz ya da reddedilir,
// ama kayda asla girmez. Kartlar sahte CLI'den (kb taklidi) gelir; S11b'nin bağlantısı HTTP uçlarıdır.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { call } from "./auth-kit.ts";
import { OK, chatRig, cliCalls, mkChat, setCards, useChatTmp } from "./chat-kit.ts";

useChatTmp();

const NOW = () => new Date().toISOString();
const ACTION_CARD = {
  id: "C-20261025-01", kind: "action_request", project: "widgets", task: "T20261025-84", state: "open", title: "T20261025-84 birleştirilsin mi?",
  options: [], answer: null, action: { kind: "merge_phase", repo: "acme/widgets", sha: "a".repeat(40) }, created: NOW(), updated: NOW(),
};
const QUESTION_CARD = {
  id: "C-20261025-02", kind: "vlad_question", project: "widgets", task: "T20261025-84", state: "open", title: "Hangi yol?",
  options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], answer: null, created: NOW(), updated: NOW(),
};

describe("action_request yalnızca kart üretir; prepare olmadan yürümez", () => {
  it("action_request kartı okunur ama okumak ya da kartı listelemek yürütme/challenge üretmez", async () => {
    const c = mkChat({}, [OK]);
    setCards(c, [ACTION_CARD]);
    const h = await chatRig(c);
    const card = await call(h.r, h.phone, "GET", `/v1/cards/${ACTION_CARD.id}`);
    expect(card.statusCode, card.body).toBe(200);
    expect(card.json()).toMatchObject({ id: ACTION_CARD.id, kind: "action_request" });
    expect(((await h.home()).json()).asks.some((a: { id: string }) => a.id === ACTION_CARD.id)).toBe(true);
    expect(h.spy.calls).toEqual([]);
    expect(h.spy.reads).toEqual([]);
    expect(existsSync(join(c.state, "challenges")) ? readdirSync(join(c.state, "challenges")) : []).toEqual([]);
  });

  it("action_request kartı /cards/{id}/answer ile çözülemez ve yürütülemez (400); CLI'ye card answer gitmez", async () => {
    const c = mkChat({}, [OK]);
    setCards(c, [ACTION_CARD]);
    const h = await chatRig(c);
    for (const body of [{ option: "approve" }, { text: "evet" }, { option: "merge" }]) {
      const res = await call(h.r, h.phone, "POST", `/v1/cards/${ACTION_CARD.id}/answer`, JSON.stringify(body));
      expect(res.statusCode, res.body).toBe(400);
    }
    expect(h.spy.calls).toEqual([]);
    expect(cliCalls(c).filter((a) => a[0] === "card" && a[1] === "answer")).toEqual([]);
  });

  it("prepare edilmemiş action_id ile approve (geçerli oturum imzasıyla) 2xx dönmez ve 0 yürütme", async () => {
    const c = mkChat({}, [OK]);
    const h = await chatRig(c);
    for (const id of ["act-yok", "00000000-0000-4000-8000-000000000000", "a".repeat(32)]) {
      const res = await call(h.r, h.phone, "POST", `/v1/actions/${id}/approve`, JSON.stringify({ signature: "AAAA" }));
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
    expect(h.spy.calls).toEqual([]);
  });

  it("sohbet turu action_request kartı yaratan bir `vlad` çağrısı yapsa bile sohbet yolu prepare/approve'a dokunmaz", async () => {
    const c = mkChat({}, [OK]);
    setCards(c, [ACTION_CARD]); // ajan kartı kb'ye yazdı
    const h = await chatRig(c);
    const r = await h.post("T20261025-84'ü birleştir", "ar-1");
    expect(r.statusCode, r.body).toBe(202);
    await c.runner.whenIdle();
    expect(h.spy.calls).toEqual([]);
    expect(h.spy.reads).toEqual([]);
    expect(existsSync(join(c.state, "challenges")) ? readdirSync(join(c.state, "challenges")) : []).toEqual([]);
  });
});

describe("by_device doğrulanmış zarftan gelir", () => {
  it("kart cevabında CLI'ye geçen --by-device, imzalı isteği gönderen cihazın kimliğidir", async () => {
    const c = mkChat({}, [OK]);
    setCards(c, [QUESTION_CARD]);
    const h = await chatRig(c);
    const res = await call(h.r, h.phone, "POST", `/v1/cards/${QUESTION_CARD.id}/answer`, JSON.stringify({ option: "a" }));
    expect(res.statusCode, res.body).toBe(200);
    const answers = cliCalls(c).filter((a) => a[0] === "card" && a[1] === "answer");
    expect(answers.length).toBe(1);
    const i = answers[0]!.indexOf("--by-device");
    expect(i).toBeGreaterThan(-1);
    expect(answers[0]![i + 1]).toBe(h.phone.id);
  });

  it("istemci gövdesindeki by_device sahteciliği kabul edilmez (400) ve CLI'ye hiçbir değer geçmez", async () => {
    const c = mkChat({}, [OK]);
    setCards(c, [QUESTION_CARD]);
    const h = await chatRig(c);
    for (const forged of ["dev-baska-cihaz", "x; rm -rf /", h.phone.id + "-x"]) {
      const res = await call(h.r, h.phone, "POST", `/v1/cards/${QUESTION_CARD.id}/answer`, JSON.stringify({ option: "a", by_device: forged }));
      expect(res.statusCode, res.body).toBe(400);
    }
    expect(cliCalls(c).filter((a) => a[0] === "card" && a[1] === "answer")).toEqual([]);
  });

  it("iki cihazdan gelen cevaplar kendi zarf kimlikleriyle yazılır (çapraz kimlik yok)", async () => {
    const c = mkChat({}, [OK]);
    setCards(c, [QUESTION_CARD, { ...QUESTION_CARD, id: "C-20261025-03" }]);
    const h = await chatRig(c);
    const { pair, Phone } = await import("./auth-kit.ts");
    const second = await pair(h.r, new Phone("Tablet"));
    const a = await call(h.r, h.phone, "POST", `/v1/cards/C-20261025-02/answer`, JSON.stringify({ option: "a" }));
    const b = await call(h.r, second, "POST", `/v1/cards/C-20261025-03/answer`, JSON.stringify({ option: "b" }));
    expect([a.statusCode, b.statusCode], `${a.body} ${b.body}`).toEqual([200, 200]);
    const by = Object.fromEntries(cliCalls(c).filter((x) => x[0] === "card" && x[1] === "answer").map((x) => [x[2], x[x.indexOf("--by-device") + 1]]));
    expect(by).toEqual({ "C-20261025-02": h.phone.id, "C-20261025-03": second.id });
  });

  it("imzasız / başkasının kimliğiyle imzalanmış cevap yazılmaz", async () => {
    const c = mkChat({}, [OK]);
    setCards(c, [QUESTION_CARD]);
    const h = await chatRig(c);
    const body = JSON.stringify({ option: "a" });
    const unsigned = await h.r.app.inject({ method: "POST", url: `/v1/cards/${QUESTION_CARD.id}/answer`, headers: { "content-type": "application/json" }, payload: body });
    expect(unsigned.statusCode).toBe(401);
    const forged = await call(h.r, h.phone, "POST", `/v1/cards/${QUESTION_CARD.id}/answer`, body, { device: "dev-baska" });
    expect(forged.statusCode).toBe(401);
    expect(cliCalls(c).filter((a) => a[0] === "card" && a[1] === "answer")).toEqual([]);
  });
});
