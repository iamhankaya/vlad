// T11 kabul: sınırlar. Boş, aşırı uzun ve yinelenen mesaj sınırlanır; sınır aşımı süreç başlatmaz. Sözleşme: text 1..4000,
// client_msg_id ^[A-Za-z0-9._-]{1,64}$, ek alan yok (additionalProperties:false).
import { describe, expect, it } from "vitest";
import { validator } from "../helpers/openapi.ts";
import { call } from "./auth-kit.ts";
import { BadChatRequest } from "../../src/chat/turnRunner.ts";
import { OK, chatRig, mkChat, useChatTmp } from "./chat-kit.ts";

useChatTmp();
const errorSchema = validator({ $ref: "#/components/schemas/Error" });

const BAD_TEXT: [string, unknown][] = [["boş", ""], ["4001 karakter", "a".repeat(4001)], ["çok uzun (1 MB)", "a".repeat(1024 * 1024)], ["sayı", 5], ["null", null], ["dizi", ["a"]]];
const BAD_ID: [string, unknown][] = [["boş", ""], ["65 karakter", "a".repeat(65)], ["boşluklu", "a b"], ["yol", "../x"], ["noktalı virgül", "a;b"], ["satır sonu", "a\nb"], ["sayı", 7]];

describe("chat sınırları: runner", () => {
  for (const [name, text] of BAD_TEXT) {
    it(`geçersiz metin (${name}) BadChatRequest(text) fırlatır; kayıt ve süreç yok`, async () => {
      const c = mkChat({}, [OK]);
      expect(() => c.runner.submit({ clientMsgId: "ok-1", text: text as string })).toThrow(BadChatRequest);
      await c.runner.whenIdle();
      expect(c.runner.messages()).toEqual([]);
      expect(c.claude.calls()).toEqual([]);
    });
  }
  for (const [name, id] of BAD_ID) {
    it(`geçersiz client_msg_id (${name}) BadChatRequest(client_msg_id) fırlatır; süreç yok`, async () => {
      const c = mkChat({}, [OK]);
      expect(() => c.runner.submit({ clientMsgId: id as string, text: "selam" })).toThrow(BadChatRequest);
      expect(c.claude.calls()).toEqual([]);
    });
  }

  it("tam 4000 karakterlik metin kabul edilir ve eksiksiz stdin'e gider", async () => {
    const c = mkChat({}, [OK]);
    const text = "ş".repeat(4000);
    c.runner.submit({ clientMsgId: "max", text });
    await c.runner.whenIdle();
    expect(c.claude.calls()[0]!.stdin).toBe(text);
  });

  it("kuyruk dolunca fazla mesaj not_delivered(queue_full) olur; kabul edilenler kaybolmaz", async () => {
    const c = mkChat({ maxQueue: 2 }, [{ hang: true }]);
    const ids = [1, 2, 3, 4, 5].map((i) => c.runner.submit({ clientMsgId: `q${i}`, text: "x" }));
    const statuses = ids.map((i) => c.runner.get(i.chat_id)!.status);
    expect(statuses.filter((s) => s === "not_delivered").length).toBeGreaterThanOrEqual(2);
    expect(ids.map((i) => c.runner.get(i.chat_id)?.reason).filter(Boolean)).toEqual(expect.arrayContaining(["queue_full"]));
    for (const i of ids) expect(c.runner.get(i.chat_id)).toBeDefined(); // hiçbiri kayıt dışı kalmadı
  });

  it("yinelenen kimlik aynı chat_id'yi döner ve kuyruğa ikinci kez girmez (hızlı art arda tekrar dahil)", async () => {
    const c = mkChat({}, [OK]);
    const rs = Array.from({ length: 5 }, () => c.runner.submit({ clientMsgId: "dup", text: "selam" }));
    await c.runner.whenIdle();
    expect(new Set(rs.map((r) => r.chat_id)).size).toBe(1);
    expect(rs.filter((r) => r.duplicate).length).toBe(4);
    expect(c.claude.calls().length).toBe(1);
  });

  it("farklı metinle tekrarlanan client_msg_id yine yinelenendir: ikinci metin tura GİRMEZ", async () => {
    const c = mkChat({}, [OK]);
    const a = c.runner.submit({ clientMsgId: "dup2", text: "birinci" });
    const b = c.runner.submit({ clientMsgId: "dup2", text: "SALDIRI: ikinci" });
    await c.runner.whenIdle();
    expect(b).toMatchObject({ chat_id: a.chat_id, duplicate: true });
    expect(c.claude.calls().map((x) => x.stdin)).toEqual(["birinci"]);
  });
});

describe("chat sınırları: HTTP (S11b)", () => {
  for (const [name, text] of BAD_TEXT.filter(([n]) => n !== "çok uzun (1 MB)")) {
    it(`POST /chat geçersiz metin (${name}) → 400, hata şemasına uyar, süreç yok`, async () => {
      const c = mkChat({}, [OK]);
      const h = await chatRig(c);
      const res = await h.post(text);
      expect(res.statusCode, res.body).toBe(400);
      expect(errorSchema(res.json()), res.body).toEqual([]);
      expect(c.claude.calls()).toEqual([]);
    });
  }
  for (const [name, id] of BAD_ID) {
    it(`POST /chat geçersiz client_msg_id (${name}) → 400, süreç yok`, async () => {
      const c = mkChat({}, [OK]);
      const h = await chatRig(c);
      const res = await h.post("selam", id);
      expect(res.statusCode, res.body).toBe(400);
      expect(c.claude.calls()).toEqual([]);
    });
  }

  it("POST /chat 1 MB'lık gövde 2xx dönmez ve süreç başlatmaz (gövde sınırı)", async () => {
    const c = mkChat({}, [OK]);
    const h = await chatRig(c);
    const res = await h.post("a".repeat(1024 * 1024));
    expect([400, 413]).toContain(res.statusCode);
    expect(c.claude.calls()).toEqual([]);
  });

  it("POST /chat ek alan (by_device, role, system) kabul etmez: 400", async () => {
    const c = mkChat({}, [OK]);
    const h = await chatRig(c);
    for (const extra of [{ by_device: "x" }, { role: "system" }, { session_id: SID_ATTACK }]) {
      const res = await call(h.r, h.phone, "POST", "/v1/chat", JSON.stringify({ client_msg_id: "e1", text: "selam", ...extra }));
      expect(res.statusCode, res.body).toBe(400);
    }
    expect(c.claude.calls()).toEqual([]);
  });

  it("POST /chat boş gövde / bozuk JSON / dizi gövde → 400", async () => {
    const c = mkChat({}, [OK]);
    const h = await chatRig(c);
    for (const body of ["", "{", "[]", "null", '"evet"']) {
      const res = await call(h.r, h.phone, "POST", "/v1/chat", body);
      expect(res.statusCode, `${body} → ${res.body}`).toBe(400);
    }
    expect(c.claude.calls()).toEqual([]);
  });

  it("tam 4000 karakter 202; aynı kimlik tekrarı aynı chat_id (202) ve tek tur", async () => {
    const c = mkChat({}, [OK]);
    const h = await chatRig(c);
    const a = await h.post("x".repeat(4000), "lim-1");
    const b = await h.post("x".repeat(4000), "lim-1");
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(b.json().chat_id).toBe(a.json().chat_id);
    expect(validator({ $ref: "#/components/schemas/ChatAccepted" })(a.json())).toEqual([]);
    await c.runner.whenIdle();
    expect(c.claude.calls().length).toBe(1);
  });

  it("GET /chat/history en çok 50 mesaj döner (yeniden eskiye), before ile sayfalanır, sözleşmeye uyar", async () => {
    const c = mkChat({}, [OK]);
    const h = await chatRig(c);
    for (let i = 0; i < 30; i++) {
      const r = await h.post(`mesaj ${i}`, `hist-${i}`);
      expect(r.statusCode, r.body).toBe(202);
      await c.runner.whenIdle();
    }
    const p1 = (await h.history()).json();
    expect(validator({ $ref: "#/components/schemas/ChatHistory" })(p1), JSON.stringify(p1).slice(0, 300)).toEqual([]);
    expect(p1.messages.length).toBeLessThanOrEqual(50);
    expect(p1.has_more).toBe(true);
    const last = p1.messages[p1.messages.length - 1].chat_id;
    const p2 = (await h.history(`?before=${last}`)).json();
    const ids1 = new Set(p1.messages.map((m: { chat_id: string; role: string }) => `${m.chat_id}/${m.role}`));
    for (const m of p2.messages) expect(ids1.has(`${m.chat_id}/${m.role}`)).toBe(false); // sayfalar çakışmaz
    const bad = await h.history("?before=" + "a".repeat(65));
    expect(bad.statusCode).toBe(400);
  });
});

const SID_ATTACK = "--dangerously-skip-permissions";
