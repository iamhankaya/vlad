// Doğrulama-3: uygulama-3 düzeltmelerinin dist CLI üzerinden uçtan uca kontrolü (geçici VLAD_HOME).
// ingest: zarfta '['/'{', çok sayfa, has_more uyarısı, rapor gövdesinde "[cloud #n]", LOG/ASK/REPORT/FAIL, result çift işleme.
// status: bulutta yerel görev stalled olmaz, session_ önekli bulut görevi olur.
// launch: bulut prompt'u işaret tekrarı kuralı + next'te permission_mode.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { CLOUD_ENV, forceRunning, newTask, readTask, taskFile, taskState, vlad, writeCard, writeRoles } from "./cloud-helpers.js";

let home: string;
let id: string;
const SHA = "b".repeat(40);
beforeEach(() => {
  home = makeHome();
  writeCard(home, "alpha", { repo: "iamhankaya/vlad" });
  // launcher "auto" opens a real local terminal on Windows; this file exercises the cloud path (F-vlad-062)
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "cloud" }));
  id = newTask(home);
  forceRunning(home, id);
});

const assistant = (text: string) => ({ assistant: { internal_anthropic_catchall: { message: { role: "assistant", content: [{ type: "text", text }] } } } });
const result = (text: string) => ({ result: { internal_anthropic_catchall: { is_error: false, result: text } } });
const page = (data: object[], has_more = false) => ({ ccr: { data, has_more } });
const seqs = (o: string): number[] => JSON.parse(o).processed.map((p: { seq: number }) => p.seq);
const ingest = (body: string, extra: string[] = []) => {
  const f = join(home, "ev.json");
  writeFileSync(f, body);
  return vlad(home, ["task", "ingest", id, "--events-file", f, "--json", ...extra]);
};

describe("ingest uçtan uca", () => {
  it("zarf metninde '[' ve '{' + çok sayfa + has_more uyarısı: ilk sayfadaki LOG da işlenir", () => {
    const p1 = page([assistant("[VLAD:LOG #1] ilk sayfa")], true);
    const p2 = page([assistant(`[VLAD:LOG #2] ikinci sayfa\n[VLAD:REPORT #3 branch=vlad/${id} head=${SHA}]\n### Yapılanlar\n- x\n[VLAD:END #3]`)], true);
    const body = `Result [ok] for {call}:\n${JSON.stringify(p1)}\n${JSON.stringify(p2)}\n(end)`;
    const r = ingest(body, ["--remote-head", SHA]);
    expect(r.code, r.out + r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(seqs(r.out)).toEqual([1, 2, 3]);
    expect(JSON.stringify(j.warnings)).toMatch(/sayfa/i);
    expect(taskState(home, id)).toBe("awaiting_approval");
    expect(readTask(home, id)).toContain("[cloud #1]");
  });

  it("rapor gövdesinde '[cloud #2]' geçse de LOG #2 atlanmaz; yeniden ingest idempotent", () => {
    const t = `[VLAD:LOG #1] a\n[VLAD:LOG #2] b\n[VLAD:REPORT #3 branch=vlad/${id} head=${SHA}]\n### Yapılanlar\n- önceki [cloud #2] etiketi örneği\n[VLAD:END #3]`;
    const ev = JSON.stringify(page([assistant(t), result(t)]));
    const r1 = ingest(ev, ["--remote-head", SHA]);
    expect(r1.code, r1.out + r1.err).toBe(0);
    expect(seqs(r1.out)).toEqual([1, 2, 3]);
    const body = readTask(home, id);
    expect(body.match(/^- .*\[cloud #2\] b/m), body).not.toBeNull();
    const r2 = ingest(ev, ["--remote-head", SHA]);
    expect(seqs(r2.out)).toEqual([]);
    expect((readTask(home, id).match(/\[cloud #1\]/g) ?? []).length).toBe(1);
  });

  it("ASK → blocked, answer → running; FAIL → failed", () => {
    const a = ingest(JSON.stringify(page([assistant("[VLAD:LOG #1] x\n[VLAD:ASK #2] a mı b mi?")])));
    expect(a.code, a.out + a.err).toBe(0);
    expect(taskState(home, id)).toBe("blocked");
    expect(readTask(home, id)).toMatch(/\[cloud #2\]/);
    expect(vlad(home, ["task", "answer", id, "a"]).code).toBe(0);
    expect(taskState(home, id)).toBe("running");
    const f = ingest(JSON.stringify(page([assistant("[VLAD:LOG #1] x\n[VLAD:ASK #2] a mı b mi?\n[VLAD:FAIL #3] derleme patladı")])));
    expect(f.code, f.out + f.err).toBe(0);
    expect(taskState(home, id)).toBe("failed");
    expect(readTask(home, id)).toContain("derleme patladı");
  });
});

describe("status bulut ortamında", () => {
  it("yerel görev (session_id null) stalled olmaz; session_ önekli bulut görevi olur", () => {
    const cloudId = newTask(home);
    forceRunning(home, cloudId);
    expect(vlad(home, ["task", "session", cloudId, "session_abc"]).code).toBe(0);
    for (const t of [id, cloudId]) {
      const f = taskFile(home, t);
      writeFileSync(f, readFileSync(f, "utf8").replace(/^updated: .*$/m, "updated: 2026-01-01T00:00:00+00:00"));
    }
    const r = vlad(home, ["status", "--json"], { env: CLOUD_ENV });
    expect(r.code, r.out + r.err).toBe(0);
    expect(taskState(home, id)).toBe("running");
    expect(taskState(home, cloudId)).toBe("stalled");
  });
});

describe("bulut launch prompt'u", () => {
  it("işaret tekrarı kuralı + next'te permission_mode", () => {
    writeRoles(home);
    const t = newTask(home, ["--role", "tester"]);
    const r = vlad(home, ["task", "launch", t, "--json"], { env: CLOUD_ENV });
    expect(r.code, r.out + r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.mode).toBe("cloud");
    expect(j.prompt).toContain("son tur mesajında tüm işaretlerini (LOG'lar ve tam REPORT dahil) tekrar et");
    expect(j.next.some((n: string) => n.includes("permission_mode"))).toBe(true);
    expect(j.permission_mode).toBe("auto");
  });
});
