// Doğrulama-2: gerçek list_events şekli etrafında uç durumlar (zarf, sayfalama, tam yaşam döngüsü).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { forceRunning, newTask, readTask, taskState, vlad, writeCard } from "./cloud-helpers.js";

let home: string;
let id: string;
beforeEach(() => {
  home = makeHome();
  writeCard(home, "alpha", { repo: "iamhankaya/vlad" });
  id = newTask(home);
  forceRunning(home, id);
});

const SHA = "b".repeat(40);
const asst = (text: string) => ({ assistant: { internal_anthropic_catchall: { message: { role: "assistant", content: [{ type: "text", text }] } } } });
const user = (text: string) => ({ user: { internal_anthropic_catchall: { message: { role: "user", content: text } } } });
const result = (text: string) => ({ result: { internal_anthropic_catchall: { is_error: false, result: text } } });
const page = (data: object[], has_more = false) => ({ ccr: { data, has_more, first_id: "a", last_id: "b" } });
const ingest = (body: string, extra: string[] = ["--remote-head", SHA]) => {
  const f = join(home, "ev.json");
  writeFileSync(f, body);
  return vlad(home, ["task", "ingest", id, "--events-file", f, ...extra, "--json"]);
};
const report = (seq: number, head = SHA) =>
  `[VLAD:REPORT #${seq} branch=vlad/${id} head=${head}]\n### Yapılanlar\n- x\n[VLAD:END #${seq}]`;

describe("zarf ve sayfalama", () => {
  it("zarf metninde '[' / '{' geçse de JSON okunur", () => {
    const body = `Result [ok] for {call}:\n${JSON.stringify(page([asst("[VLAD:LOG #1] merhaba")]))}\n[end of output]`;
    const r = ingest(body);
    expect(r.code, r.out + r.err).toBe(0);
    expect(readTask(home, id)).toContain("[cloud #1]");
  });

  it("birden çok sayfa (ardışık {ccr} nesneleri) birleştirilince işaretler işlenir", () => {
    const body = JSON.stringify(page([asst("[VLAD:LOG #1] a")], true)) + "\n" + JSON.stringify(page([asst("[VLAD:LOG #2] b")]));
    const r = ingest(body);
    expect(r.code, r.out + r.err).toBe(0);
    const t = readTask(home, id);
    expect(t).toContain("[cloud #1]");
    expect(t).toContain("[cloud #2]");
  });

  it("has_more=true ise sessiz kalmaz: uyarı verir", () => {
    const r = ingest(JSON.stringify(page([asst("[VLAD:LOG #5] sonradan")], true)));
    expect(r.code, r.out + r.err).toBe(0);
    expect(JSON.parse(r.out).warnings.join(" ")).toMatch(/has_more|sayfa/i);
  });
});

describe("yaşam döngüsü", () => {
  it("user olayındaki protokol örneği yok sayılır", () => {
    const r = ingest(JSON.stringify(page([user("[VLAD:LOG #1] örnek"), asst("selam")])));
    expect(r.code, r.out + r.err).toBe(0);
    expect(readTask(home, id)).not.toContain("[cloud #1]");
  });

  it("LOG + ASK: blocked; answer sonrası yeniden çalıştırma idempotent, durum running kalır", () => {
    const body = JSON.stringify(page([asst("[VLAD:LOG #1] x\n[VLAD:ASK #2] soru?"), result("[VLAD:LOG #1] x\n[VLAD:ASK #2] soru?")]));
    expect(ingest(body).code).toBe(0);
    expect(taskState(home, id)).toBe("blocked");
    expect(vlad(home, ["task", "answer", id, "cevap"]).code).toBe(0);
    const r2 = ingest(body);
    expect(r2.code, r2.out + r2.err).toBe(0);
    expect(JSON.parse(r2.out).processed).toEqual([]);
    expect(taskState(home, id)).toBe("running");
    expect((readTask(home, id).match(/\[cloud #2\]/g) ?? []).length).toBe(1);
  });

  it("FAIL: görev failed, error dolu", () => {
    expect(ingest(JSON.stringify(page([asst("[VLAD:FAIL #1] build kırıldı")]))).code).toBe(0);
    expect(taskState(home, id)).toBe("failed");
    expect(readTask(home, id)).toContain("error: build kırıldı");
  });

  it("REPORT: --remote-head uyuşmazsa awaiting_approval olmaz, uyarı verir", () => {
    const r = ingest(JSON.stringify(page([asst(report(1))])), ["--remote-head", "c".repeat(40)]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(taskState(home, id)).toBe("running");
    expect(JSON.parse(r.out).warnings.join(" ")).toMatch(/eşleşmiyor/);
  });

  it("REPORT eşleşince awaiting_approval; ikinci çalıştırma idempotent", () => {
    const body = JSON.stringify(page([asst(report(1)), result(report(1))]));
    expect(ingest(body).code).toBe(0);
    expect(taskState(home, id)).toBe("awaiting_approval");
    const r2 = ingest(body);
    expect(r2.code, r2.out + r2.err).toBe(0);
    expect(JSON.parse(r2.out).skipped).toEqual([1]);
  });

  it("ASK sonrası cevap + REPORT aynı transcript'te geç işlenirse görev kilitlenmez", () => {
    // geç ingest: ASK blocked yapar, REPORT blocked'tan geçemez -> en azından uyarı + ikinci tur işlemeli
    const body = JSON.stringify(page([asst("[VLAD:ASK #1] soru?"), asst(report(2))]));
    const r = ingest(body);
    expect(r.code, r.out + r.err).toBe(0);
    expect(vlad(home, ["task", "answer", id, "c"]).code).toBe(0);
    const r2 = ingest(body);
    expect(r2.code, r2.out + r2.err).toBe(0);
    expect(taskState(home, id)).toBe("awaiting_approval");
  });
});
