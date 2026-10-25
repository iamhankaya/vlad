// T11 kabul: mesaj kaybı. Her mesaj `done` ya da `not_delivered` biter; hiçbiri sessizce kaybolmaz ve aynı `client_msg_id` ikinci
// bir tur başlatmaz. `not_delivered` sonucu `chat.done` olayıyla duyurulur (sözleşme: ChatMessage'ta durum alanı yok, olay var).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASE, CRASH, OK, TURN_TIMEOUT, chatRig, events, mkChat, useChatTmp, waitFor } from "./chat-kit.ts";

useChatTmp();

const done = (c: ReturnType<typeof mkChat>) => events(c.ledger, "chat.done").map((e) => e.data);

describe("chat: çökme ve zaman aşımında mesaj not_delivered olur", () => {
  it("süreç tur ortasında çökerse (çıkış 1, sonuç yok) mesaj not_delivered(+neden) olur ve yeniden denenmez", async () => {
    const c = mkChat({}, [{ lines: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "yarım" }] } })], exit: 1, stderr: "kaza" }, OK]);
    const m = c.runner.submit({ clientMsgId: "d1", text: "selam" });
    await c.runner.whenIdle();
    expect(c.runner.get(m.chat_id)).toMatchObject({ status: "not_delivered", reason: "exit_1" });
    expect(c.claude.calls().length).toBe(1); // başlamış tur tekrarlanmaz (yan etki çoğalmasın)
    expect(done(c)).toEqual([{ chat_id: m.chat_id, status: "not_delivered", reason: "exit_1" }]);
  });

  it("asılı kalan tur zaman aşımında öldürülür; mesaj not_delivered(timeout), zamanlayıcı temizlenir", async () => {
    const c = mkChat({}, [{ lines: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "..." }] } })], hang: true }]);
    const m = c.runner.submit({ clientMsgId: "d2", text: "selam" });
    await waitFor(() => c.claude.startedPid() !== null, "çocuk başladı");
    const pid = c.claude.startedPid()!;
    c.timers.fire(TURN_TIMEOUT);
    await c.runner.whenIdle();
    expect(c.runner.get(m.chat_id)).toMatchObject({ status: "not_delivered", reason: "timeout" });
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "asılı çocuk öldü");
    expect(c.timers.pending(TURN_TIMEOUT)).toBe(false);
  });

  it("hiç başlamamış tur (başlatma hatası) yeniden denenir; deneme hakkı bitince not_delivered olur, sessizce düşmez", async () => {
    const c = mkChat({ maxAttempts: 2, downAfter: 50 }, [CRASH]);
    const m = c.runner.submit({ clientMsgId: "d3", text: "selam" });
    await c.runner.whenIdle();
    expect(c.runner.get(m.chat_id)?.status).toBe("queued"); // geri çekilme bekliyor, mesaj düşmedi
    c.timers.fire(BASE);
    await c.runner.whenIdle();
    expect(c.runner.get(m.chat_id)?.status).toBe("not_delivered");
    expect(c.claude.calls().length).toBe(2);
  });

  it("sunucu tur sürerken ölürse: yeniden başlatmada yarım mesaj not_delivered(restart), kuyrukta bekleyen çalışır, hiçbiri kaybolmaz", async () => {
    const c = mkChat({}, [OK]);
    mkdirSync(c.state, { recursive: true });
    const L = (o: object) => JSON.stringify(o) + "\n";
    const at = new Date(c.clock.t).toISOString();
    writeFileSync(join(c.state, "chat.jsonl"),
      L({ t: "msg", chat_id: "chat-1", client_msg_id: "a", text: "bir", at, status: "queued" }) + L({ t: "set", chat_id: "chat-1", status: "running" }) +
      L({ t: "msg", chat_id: "chat-2", client_msg_id: "b", text: "iki", at, status: "queued" }) + '{"t":"msg","chat_id":"chat-3","client_');
    const r2 = c.make(); // ilk örnek boş dosyayla başladı; kaza sonrası yeni süreç
    await r2.whenIdle();
    expect(r2.get("chat-1")).toMatchObject({ status: "not_delivered", reason: "restart" });
    expect(r2.get("chat-2")?.status).toBe("done");
    expect(r2.messages().map((x) => x.chat_id)).toEqual(["chat-1", "chat-2"]); // yırtık son satır sessizce atlanır
    // bir sonraki yeniden başlatma aynı durumu görür: yırtık satıra eklenen ilk satır yüzünden hiçbir mesajın durumu geri dönmez
    r2.stop();
    const r3 = c.make();
    await r3.whenIdle();
    expect(r3.get("chat-1")?.status).toBe("not_delivered");
    expect(r3.get("chat-2")?.status).toBe("done");
    expect(r3.get("chat-2")?.reply).toBeTruthy();
    expect(c.claude.calls().length).toBe(1); // ikinci kez çalıştırılmadı
  });

  it("client_msg_id yeniden başlatmadan sonra da yinelenmez: aynı kimlik eski chat_id'yi döner, yeni süreç başlamaz", async () => {
    const c = mkChat({}, [OK]);
    const a = c.runner.submit({ clientMsgId: "once", text: "selam" });
    await c.runner.whenIdle();
    const calls = c.claude.calls().length;
    const r2 = c.make();
    const b = r2.submit({ clientMsgId: "once", text: "selam" });
    await r2.whenIdle();
    expect(b).toMatchObject({ chat_id: a.chat_id, duplicate: true });
    expect(c.claude.calls().length).toBe(calls);
  });

  it("not_delivered olan mesajın aynı client_msg_id ile tekrarı yeni tur AÇMAZ (kullanıcı yeni kimlikle yeniden gönderir)", async () => {
    const c = mkChat({}, [{ lines: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "yarım" }] } })], exit: 1 }, OK]);
    const a = c.runner.submit({ clientMsgId: "fail-1", text: "selam" });
    await c.runner.whenIdle();
    expect(c.runner.get(a.chat_id)?.status).toBe("not_delivered");
    const again = c.runner.submit({ clientMsgId: "fail-1", text: "selam" });
    await c.runner.whenIdle();
    expect(again).toMatchObject({ chat_id: a.chat_id, duplicate: true });
    expect(c.claude.calls().length).toBe(1);
    const fresh = c.runner.submit({ clientMsgId: "fail-2", text: "selam" });
    await c.runner.whenIdle();
    c.timers.fire(BASE); // başarısız turun geri çekilmesi
    await c.runner.whenIdle();
    expect(c.runner.get(fresh.chat_id)?.status).toBe("done");
  });
});

describe("chat: teslim durumu HTTP'den görünür (S11b)", () => {
  it("POST /chat 202 + chat_id; çöken turun sonucu SSE ledger'ında chat.done(not_delivered) olarak yayımlanır", async () => {
    const c = mkChat({}, [{ lines: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "yarım" }] } })], exit: 1 }]);
    const h = await chatRig(c);
    const res = await h.post("selam", "http-d1");
    expect(res.statusCode, res.body).toBe(202);
    const { chat_id } = res.json();
    await c.runner.whenIdle();
    expect(done(c)).toContainEqual({ chat_id, status: "not_delivered", reason: "exit_1" });
  });

  it("yinelenen client_msg_id: ikinci POST aynı chat_id ile 202, tek tur", async () => {
    const c = mkChat({}, [OK]);
    const h = await chatRig(c);
    const a = await h.post("selam", "same-1");
    const b = await h.post("selam", "same-1");
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(b.json().chat_id).toBe(a.json().chat_id);
    await c.runner.whenIdle();
    expect(c.claude.calls().length).toBe(1);
  });
});
