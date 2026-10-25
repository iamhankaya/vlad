// T11 kabul: devamlılık. Geçersiz resume kimliği yedek yola düşer; çökme döngüsü üstel geri çekilmeyle sınırlanır ve `session_down`
// `/home` uyarılarında görünür; oturum geri gelince uyarı kalkar. Runner düzeyi S11a'ya, HTTP düzeyi S11b'ye karşıdır.
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validator } from "../helpers/openapi.ts";
import { BASE, CRASH, MAX, OK, SID1, chatRig, events, mkChat, useChatTmp } from "./chat-kit.ts";

useChatTmp();

const NO_SESSION: import("../helpers/fakeClaude.ts").FakeStep = { fixture: "resume-invalid-session.jsonl", exit: 1, stderr: "No conversation found with session ID: 00000000-0000-4000-8000-0000000000aa" };

describe("chat devamlılığı: geçersiz resume kimliği", () => {
  it("kayıtlı oturum yok sayılırsa aynı mesaj yeni oturumla teslim edilir; sonraki mesaj ESKİ değil YENİ kimliği sürdürür", async () => {
    const c = mkChat({}, [NO_SESSION, OK, { fixture: "resume-turn2.jsonl" }]);
    mkdirSync(c.state, { recursive: true });
    c.sessions.set("00000000-0000-4000-8000-0000000000aa");
    const a = c.runner.submit({ clientMsgId: "r1", text: "selam" });
    await c.runner.whenIdle();
    expect(c.runner.get(a.chat_id)?.status).toBe("done"); // mesaj kaybolmadı, yedek yol teslim etti
    const [first, second] = c.claude.calls();
    expect(first!.argv).toContain("--resume");
    expect(second!.argv).not.toContain("--resume");
    expect(second!.stdin).toBe("selam"); // aynı metin, yeniden yazılmadı
    expect(c.sessions.get()).toBe(SID1);

    const b = c.runner.submit({ clientMsgId: "r2", text: "bir daha" });
    await c.runner.whenIdle();
    expect(c.runner.get(b.chat_id)?.status).toBe("done");
    const third = c.claude.calls()[2]!;
    expect(third.argv.slice(third.argv.indexOf("--resume"))).toEqual(["--resume", SID1]);
  });

  it("yedek yol sonsuz döngü kurmaz: her deneme en çok bir ek süreç; kalıcı geçersizlik not_delivered ile biter", async () => {
    const c = mkChat({ maxAttempts: 1 }, [NO_SESSION]);
    c.sessions.set("00000000-0000-4000-8000-0000000000aa");
    const a = c.runner.submit({ clientMsgId: "r3", text: "selam" });
    await c.runner.whenIdle();
    expect(c.runner.get(a.chat_id)?.status).toBe("not_delivered");
    expect(c.claude.calls().length).toBeLessThanOrEqual(2);
  });
});

describe("chat devamlılığı: çökme döngüsü", () => {
  it("üst üste çökmelerde bekleme 1x, 2x, 4x... katlanır, tavanı aşmaz; eşikte session_down açılır ve süreç sayısı sınırlı kalır", async () => {
    const c = mkChat({ downAfter: 5, maxAttempts: 50 }, [CRASH]);
    const m = c.runner.submit({ clientMsgId: "k1", text: "selam" });
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      await c.runner.whenIdle();
      const ms = Date.parse(c.runner.state().retry_at!) - c.clock.t;
      waits.push(ms);
      c.timers.fire(ms);
    }
    await c.runner.whenIdle();
    expect(waits).toEqual([BASE, 2 * BASE, 4 * BASE, MAX]);
    expect(c.runner.state()).toMatchObject({ status: "session_down", failures: 5, queued: 0 });
    expect(c.runner.get(m.chat_id)).toMatchObject({ status: "not_delivered", reason: "session_down" });
    expect(c.claude.calls().length).toBe(5); // sonsuz yeniden başlatma yok
    expect(c.timers.items.size).toBe(0);
  });

  it("session_down iken yeni mesaj anında not_delivered olur ve süreç başlatılmaz; bekleme bitince tek deneme (probe) yapılır", async () => {
    const c = mkChat({ downAfter: 1 }, [CRASH, CRASH, OK]);
    c.runner.submit({ clientMsgId: "k2", text: "x" });
    await c.runner.whenIdle();
    expect(c.runner.state().status).toBe("session_down");
    const spawned = c.claude.calls().length;
    const refused = c.runner.submit({ clientMsgId: "k3", text: "y" });
    expect(refused.status).toBe("not_delivered");
    expect(c.claude.calls().length).toBe(spawned);
    c.clock.t += MAX;
    const probe = c.runner.submit({ clientMsgId: "k4", text: "z" });
    await c.runner.whenIdle();
    expect(c.claude.calls().length).toBe(spawned + 1);
    expect(c.runner.get(probe.chat_id)?.status).toBe("not_delivered"); // probe de çöktü
    expect(c.runner.state().status).toBe("session_down");
  });

  it("çökme döngüsünden sonra oturum düzelirse durum idle'a döner ve uyarı kalkar", async () => {
    const c = mkChat({ downAfter: 1 }, [CRASH, OK]);
    c.runner.submit({ clientMsgId: "k5", text: "x" });
    await c.runner.whenIdle();
    expect(c.runner.warnings().length).toBe(1);
    c.clock.t += MAX;
    const ok = c.runner.submit({ clientMsgId: "k6", text: "y" });
    await c.runner.whenIdle();
    expect(c.runner.get(ok.chat_id)?.status).toBe("done");
    expect(c.runner.state()).toMatchObject({ status: "idle", failures: 0, last_error: null });
    expect(c.runner.warnings()).toEqual([]);
  });

  it("yeniden başlatma çökme sayacını sıfırlamaz mı: kapalı oturum bildirimi kayıtlı mesajlarla tutarlı (session_down mesajı not_delivered kalır)", async () => {
    const c = mkChat({ downAfter: 1 }, [CRASH]);
    const m = c.runner.submit({ clientMsgId: "k7", text: "x" });
    await c.runner.whenIdle();
    const r2 = c.make();
    expect(r2.get(m.chat_id)).toMatchObject({ status: "not_delivered", reason: "session_down" });
    expect(events(c.ledger, "chat.done").filter((e) => e.data.chat_id === m.chat_id).length).toBe(1);
  });
});

describe("chat devamlılığı: /home (S11b)", () => {
  it("çökme döngüsü /home uyarılarında session_down olarak görünür, sözleşmeye uyar; iyileşince kalkar", async () => {
    const c = mkChat({ downAfter: 2, maxAttempts: 5 }, [CRASH, CRASH, OK]);
    const h = await chatRig(c);
    expect(((await h.home()).json()).warnings).toEqual([]);
    const res = await h.post("selam", "h1");
    expect(res.statusCode, res.body).toBe(202);
    await c.runner.whenIdle();
    c.timers.fire(BASE);
    await c.runner.whenIdle();
    const home = (await h.home()).json();
    expect(validator({ $ref: "#/components/schemas/Home" })(home)).toEqual([]);
    expect(home.warnings.some((w: string) => w.includes("session_down"))).toBe(true);
    c.clock.t += MAX;
    const ok = await h.post("tekrar", "h2");
    expect(ok.statusCode, ok.body).toBe(202);
    await c.runner.whenIdle();
    expect(((await h.home()).json()).warnings).toEqual([]);
  });

  it("session_down iken POST /chat reddetmez: 202 döner ve mesaj chat.done(not_delivered, session_down) olur", async () => {
    const c = mkChat({ downAfter: 1 }, [CRASH]);
    const h = await chatRig(c);
    await h.post("x", "h3");
    await c.runner.whenIdle();
    const res = await h.post("y", "h4");
    expect(res.statusCode, res.body).toBe(202);
    const done = events(c.ledger, "chat.done").map((e) => e.data);
    expect(done).toContainEqual({ chat_id: res.json().chat_id, status: "not_delivered", reason: "session_down" });
  });
});
