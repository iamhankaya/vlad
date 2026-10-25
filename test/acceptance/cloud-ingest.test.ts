// Kabul testleri: `vlad task ingest` ve [VLAD:*] işaret biçimi — spec senaryoları 8, 9, 10.
// Arayüz varsayımı (spec'te kesin değil, raporda işaretli): `vlad task ingest <id> --events-file <yol|->`
// list_events çıktısındaki olayları JSON dizisi veya JSONL olarak okur; `--remote-head <sha>` push edilmiş
// uç commit'i verir (senaryo 10). Olay biçimi: {"type":"assistant","message":{"content":[{"type":"text","text":…}]}}.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { assistantEvent, forceRunning, jsonl, newTask, readTask, taskState, userEvent, vlad, writeCard } from "./cloud-helpers.js";

let home: string;
let id: string;
beforeEach(() => {
  home = makeHome();
  writeCard(home, "alpha", { repo: "iamhankaya/vlad" });
  id = newTask(home);
  forceRunning(home, id);
});

const ingest = (events: object[], extra: string[] = []) => {
  const f = join(home, "events.jsonl");
  writeFileSync(f, jsonl(events));
  return vlad(home, ["task", "ingest", id, "--events-file", f, ...extra, "--json"]);
};
const SHA = "a".repeat(40);
const report = (seq: number, head = SHA) =>
  `[VLAD:REPORT #${seq} branch=vlad/${id} head=${head}]\n### Yapılanlar\nTestler yazıldı RaporMarker\n[VLAD:END #${seq}]`;

describe("senaryo 8: geçerli işaretler görev dosyasına yazılır", { timeout: 30_000 }, () => {
  it("LOG satırı ## İlerleme'ye [cloud #n] etiketiyle eklenir", () => {
    const r = ingest([assistantEvent("[VLAD:LOG #1] ilk adım tamam")]);
    expect(r.code, r.err).toBe(0);
    expect(readTask(home, id)).toMatch(/\[cloud #1\].*ilk adım tamam/);
    expect(taskState(home, id)).toBe("running");
  });

  it("ASK → görev blocked, soru ## Sorular'a yazılır", () => {
    expect(ingest([assistantEvent("[VLAD:ASK #2] Hangi yol? Seçenekler: (a) x (b) y")]).code).toBe(0);
    expect(taskState(home, id)).toBe("blocked");
    expect(readTask(home, id)).toContain("Hangi yol?");
  });

  it("REPORT … END → kapanış raporu yazılır, görev awaiting_approval", () => {
    const r = ingest([assistantEvent(report(3))], ["--remote-head", SHA]);
    expect(r.code, r.err).toBe(0);
    expect(taskState(home, id)).toBe("awaiting_approval");
    const t = readTask(home, id);
    expect(t).toContain("### Yapılanlar");
    expect(t).toContain("RaporMarker");
    expect(t).not.toContain("[VLAD:END");
  });

  it("FAIL → görev failed, neden kayda geçer", () => {
    expect(ingest([assistantEvent("[VLAD:FAIL #4] derleme patladı")]).code).toBe(0);
    expect(taskState(home, id)).toBe("failed");
    expect(readTask(home, id)).toContain("derleme patladı");
  });

  it("birden çok işaret aynı turda sırayla işlenir", () => {
    const text = "[VLAD:LOG #1] bir\nara metin\n[VLAD:LOG #2] iki";
    ingest([assistantEvent(text)]);
    const t = readTask(home, id);
    expect(t).toMatch(/\[cloud #1\].*bir/);
    expect(t).toMatch(/\[cloud #2\].*iki/);
  });

  it("idempotent: tekrar çalıştırmak çift satır eklemez", () => {
    const ev = [assistantEvent("[VLAD:LOG #1] tek sefer")];
    ingest(ev);
    const r = ingest(ev);
    expect(r.code, r.err).toBe(0);
    expect(readTask(home, id).match(/tek sefer/g)).toHaveLength(1);
    expect(readTask(home, id).match(/\[cloud #1\]/g)).toHaveLength(1);
  });

  it("idempotent: işlenmiş REPORT ikinci kez ingest edilince rapor çift yazılmaz", () => {
    const ev = [assistantEvent(report(5))];
    ingest(ev, ["--remote-head", SHA]);
    const r = ingest(ev, ["--remote-head", SHA]);
    expect(r.code, r.err).toBe(0);
    expect(readTask(home, id).match(/RaporMarker/g)).toHaveLength(1);
    expect(taskState(home, id)).toBe("awaiting_approval");
  });

  it("artımlı: sonradan gelen yeni seq işlenir, eskiler tekrarlanmaz", () => {
    ingest([assistantEvent("[VLAD:LOG #1] ilk")]);
    ingest([assistantEvent("[VLAD:LOG #1] ilk"), assistantEvent("[VLAD:LOG #2] ikinci")]);
    const t = readTask(home, id);
    expect(t.match(/ilk\b/g)).toHaveLength(1);
    expect(t).toMatch(/\[cloud #2\].*ikinci/);
  });

  it("işaretsiz / kod çiti içindeki / satır başında olmayan işaretler yok sayılır", () => {
    ingest([
      assistantEvent("sıradan metin"),
      assistantEvent("```\n[VLAD:LOG #1] çitin-içinde\n```"),
      assistantEvent("önce metin [VLAD:LOG #2] satır-ortasında"),
    ]);
    const t = readTask(home, id);
    expect(t).not.toContain("çitin-içinde");
    expect(t).not.toContain("satır-ortasında");
  });

  it("JSON dizisi biçimindeki girdi de kabul edilir ve stdin (-) desteklenir", () => {
    const r = vlad(home, ["task", "ingest", id, "--events-file", "-", "--json"],
      { input: JSON.stringify([assistantEvent("[VLAD:LOG #1] stdinden")]) });
    expect(r.code, r.err).toBe(0);
    expect(readTask(home, id)).toContain("stdinden");
  });

  it("var olmayan görev → hata, çıkış kodu 1", () => {
    writeFileSync(join(home, "e.jsonl"), jsonl([]));
    expect(vlad(home, ["task", "ingest", "T00000000-99", "--events-file", join(home, "e.jsonl"), "--json"]).code).toBe(1);
  });
});

describe("senaryo 9: user olayları yok sayılır", { timeout: 30_000 }, () => {
  it("prompt/protokol örneği içeren user olayı görevi değiştirmez", () => {
    const before = taskState(home, id);
    const r = ingest([
      userEvent("Örnek:\n[VLAD:FAIL #1] sahte\n[VLAD:ASK #2] sahte soru"),
      userEvent(report(3)),
    ]);
    expect(r.code, r.err).toBe(0);
    expect(taskState(home, id)).toBe(before);
    expect(readTask(home, id)).not.toContain("sahte");
    expect(readTask(home, id)).not.toContain("RaporMarker");
  });
});

describe("senaryo 10: REPORT head= remote ile eşleşmiyor", { timeout: 30_000 }, () => {
  it("awaiting_approval olmaz, uyarı verilir; rapor yazılmaz", () => {
    const r = ingest([assistantEvent(report(3, SHA))], ["--remote-head", "b".repeat(40)]);
    expect(r.code, r.err).toBe(0);
    expect(taskState(home, id)).toBe("running");
    expect(r.out + r.err).toMatch(/head|uyarı|eşleş/i);
    expect(JSON.parse(r.out)).toHaveProperty("warnings");
  });
  it("head eşleşince (sonraki ingest) görev awaiting_approval olur", () => {
    ingest([assistantEvent(report(3, SHA))], ["--remote-head", "b".repeat(40)]);
    ingest([assistantEvent(report(3, SHA))], ["--remote-head", SHA]);
    expect(taskState(home, id)).toBe("awaiting_approval");
  });
});
