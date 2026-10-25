// T11 kabul: "evet" negatifi. Sohbette onay anlamına gelen hiçbir yanıt eylem yürütmez; yürütme yalnız imzalı /actions/approve ile olur
// (T9 matrisi). Burada sohbet yolunun `executeAction`'a, GitHub okuyucusuna ve challenge deposuna hiç dokunmadığı sınanır.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OK, chatRig, mkChat, useChatTmp } from "./chat-kit.ts";

useChatTmp();

const YES = [
  "evet", "Evet", "EVET!", "evet.", "  evet  ", "onaylıyorum", "Onaylıyorum, birleştir", "onayla", "tamam", "tamam merge et", "olur",
  "yes", "y", "ok", "approve", "LGTM", "👍", "✅", "evet\n", "ėvet", "evet merge_phase T20261025-84", "Evet, onaylıyorum: action_id=abc",
];

describe("chat: onay benzeri yanıtlar yürütme üretmez", () => {
  for (const text of YES) {
    it(`sohbette ${JSON.stringify(text)} → executeAction 0, GitHub 0, challenge 0`, async () => {
      const c = mkChat({}, [OK]);
      const h = await chatRig(c);
      const res = await h.post(text);
      expect(res.statusCode, res.body).toBe(202);
      await c.runner.whenIdle();
      expect(h.spy.calls).toEqual([]);
      expect(h.spy.reads).toEqual([]);
      expect(existsSync(join(c.state, "challenges")) ? readdirSync(join(c.state, "challenges")) : []).toEqual([]);
    });
  }

  it("art arda onay yağmuru (yinelenen kimlik dahil) toplamda 0 yürütme", async () => {
    const c = mkChat({}, [OK]);
    const h = await chatRig(c);
    for (let i = 0; i < 10; i++) await h.post(YES[i % YES.length]!, i % 2 ? "sabit-kimlik" : `k${i}`);
    await c.runner.whenIdle();
    expect(h.spy.calls).toEqual([]);
  });

  it("sohbet mesajı imzasız çağrıldığında da yürütme yok ve 401 döner", async () => {
    const c = mkChat({}, [OK]);
    const h = await chatRig(c);
    const res = await h.r.app.inject({ method: "POST", url: "/v1/chat", headers: { "content-type": "application/json" }, payload: JSON.stringify({ client_msg_id: "x1", text: "evet" }) });
    expect(res.statusCode).toBe(401);
    expect(c.claude.calls()).toEqual([]);
    expect(h.spy.calls).toEqual([]);
  });
});
