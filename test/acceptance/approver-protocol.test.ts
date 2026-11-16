import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireModeAuthority } from "../../src/mode/token.js";
import { LIMITS } from "../../src/approver/types.js";
import type { RejectReason } from "../../src/approver/types.js";
import { SECRET_PATTERNS, secretHits } from "../support/approver-secrets.js";
import { dirFiles, logText, makeCid, makeWorld, resultOf, sleep, startService, submit, untilStream, untilWatching, waitAck, waitFor, writeRequest } from "./approver-harness.js";
import type { World } from "./approver-harness.js";

// approver-kabul: istemci↔servis protokolü, bildirim, tek kullanım, TTL, yetkisiz yanıt, allowlist.
// Seviye: süreç içi `runApprover(deps)` + loopback sahte ntfy + gerçek NtfyChannel/Store; saat sahte (yalnız süreç içi).
// Varsayımlar (spec): düğme gövdesi `a1|d1.<id>.<tag>`; sonuç `store.readResult(id)`; log kodları `DropReason` tam kodudur.
const NIGHT = ["mode", "night", "--until", "23:00"];
let w: World;
beforeEach(async () => { w = await makeWorld(); });
afterEach(async () => { await w.dispose(); });

async function boot(): Promise<void> { startService(w); await untilWatching(w); }

describe("approver-kabul: KK1 bildirim servis tarafında", () => {
  it("istek dosyasındaki message/title/nonce/id/respTopic/tag alanları yok sayılır; bildirim şablonu servisin kendi verisinden", async () => {
    await boot();
    const r = await submit(w, [...NIGHT, "--note", "gece işi"], {
      extra: { title: "SAHTE-BASLIK", message: "SAHTE-MESAJ", nonce: "f".repeat(32), id: "z".repeat(26), respTopic: "vlad-r-" + "z".repeat(26), tag: "e".repeat(64), topic: "vlad-q-" + "z".repeat(26) },
    });
    expect(r.ack.status).toBe("pending");
    const p = r.pending!, m = r.msg!;
    expect(r.ack.id).toBe(p.id);
    expect(p.cid).toBe(r.cid);
    expect(p.id).toMatch(/^[a-z2-7]{26}$/); expect(p.id).not.toBe(r.cid); // cid ↔ id ayrımı
    expect(p.shortId).toBe(p.id.slice(0, 8));
    expect(p.nonce).toMatch(/^[0-9a-f]{32}$/); expect(p.nonce).not.toBe("f".repeat(32));
    expect(p.respTopic).toMatch(/^vlad-r-[a-z2-7]{26}$/); expect(p.respTopic).not.toContain("zzzz");
    expect(m.topic).toBe(w.cfg.requestTopic);
    expect(m.title).toBe("VLAD onay: mode night");
    const all = JSON.stringify(m.raw);
    for (const bad of ["SAHTE-BASLIK", "SAHTE-MESAJ", "e".repeat(64)]) expect(all).not.toContain(bad);
    // şablon (plan "renderNotification"): satır sırası ve etiketleri
    const lines = m.message.split("\n");
    expect(lines[0]).toBe("İşlem: vlad mode night --until 23:00 --note gece işi");
    expect(lines[1]).toBe("İsteyen: vlad-07 (beyan, doğrulanmamış)");
    expect(lines[2]).toMatch(/^Hedef: .+ \| kb: .+$/);
    expect(lines[3]).toMatch(/^İstek: \d\d:\d\d:\d\d · Geçerli: \d\d:\d\d:\d\d$/);
    expect(lines[4]).toBe(`Kimlik: ${p.shortId}`);
    expect(lines).toHaveLength(5);
    // süre: son geçerlilik = istek + 5 dk (LIMITS.approveTtlMs)
    expect(new Date(p.expiresAt).getTime() - new Date(p.requestedAt).getTime()).toBe(LIMITS.approveTtlMs);
  });

  it("düğmeler: önce Reddet sonra Onayla; ikisi de yanıt konusuna POST; gövde ^(d1|a1).<id>.<64 hex>$; konu action URL'sinde", async () => {
    await boot();
    const { pending: p, msg: m } = await submit(w, NIGHT);
    expect(m!.actions.map((a) => a.label)).toEqual(["Reddet", "Onayla"]);
    for (const a of m!.actions) {
      expect(a.action).toBe("http"); expect(a.method).toBe("POST");
      expect(a.url).toBe(`${w.cfg.server}/${p!.respTopic}`);
    }
    expect(m!.actions[0]!.body).toMatch(new RegExp(`^d1\\.${p!.id}\\.[0-9a-f]{64}$`));
    expect(m!.actions[1]!.body).toMatch(new RegExp(`^a1\\.${p!.id}\\.[0-9a-f]{64}$`));
    expect(m!.actions[0]!.body.split(".")[2]).not.toBe(m!.actions[1]!.body.split(".")[2]);
  });

  it("ctx servisin çözdüğü VLAD_HOME'dur (istek dosyasından değil); digest plandaki formüle uyar", async () => {
    const { digestOf } = await import("./approver-harness.js");
    await boot();
    const { pending: p } = await submit(w, NIGHT);
    expect(p!.ctx.home).toBe(w.vladHome);
    expect(p!.ctx.kb).toMatch(/\S/); expect(p!.ctx.cli).toMatch(/cli\.js$/);
    expect(p!.digest).toBe(digestOf(p!));
    expect(p!.keyGen).toMatch(/^[0-9a-f]{16}$/);
  });

  it("bildirimde ve loglarda anahtar/token/not'un 60 baytından sonrası/mutlak yol yok (konu yalnız action URL'sinde)", async () => {
    await boot();
    const note = Array.from({ length: 14 }, (_, i) => `ş${((i + 3) * 7919 % 9973).toString(36)}q${i}`).join("-"); // ~120 bayt (≤ 200) // > 60 bayt, çok baytlı, APERİYODİK (kuyruk başka yerde eşleşmez)
    const { msg: m } = await submit(w, [...NIGHT, "--note", note]);
    const shown = `${m!.title}\n${m!.message}`;
    expect(secretHits(shown), "bildirim metni").toEqual([]);
    expect(shown).not.toContain(w.key);
    expect(shown).not.toContain(w.cfg.requestTopic);
    const tail = Buffer.from(note, "utf8").subarray(80).toString("utf8").trim();
    expect(shown).not.toContain(tail);
    expect(shown).toContain("…");
    expect(logText(w)).not.toContain(w.key);
    expect(secretHits(logText(w))).toEqual([]);
  });
});

describe("approver-kabul: KK2 özete bağlı onay, KK3 tek kullanım, karar yarışı", () => {
  it("onay → yürütücü tam argv ve işlem bağlı VMT2 ile bir kez çağrılır; token argv'ye bağlı ve tek kullanımlıdır", async () => {
    await boot();
    const { pending: p, msg: m } = await submit(w, NIGHT);
    await w.ntfy.press(m!, "Onayla");
    const res = await resultOf(w, p!.id);
    expect(res.status).toBe("done"); expect(res.exitCode).toBe(0);
    expect(w.exec.calls).toHaveLength(1);
    const c = w.exec.calls[0]!;
    expect(c.argv).toEqual(NIGHT);
    expect(c.token).toMatch(/^VMT2\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}\.[0-9a-f]{64}$/);
    const now = w.clock.now();
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: c.token }, now, ["mode", "night", "--until", "00:00"])).toThrow(); // başka argv
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: c.token }, now, NIGHT)).not.toThrow(); // doğru argv bir kez
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: c.token }, now, NIGHT)).toThrow(); // ikinci kullanım
    expect(JSON.stringify(res)).not.toContain(c.token);
    expect(logText(w)).not.toContain(c.token);
  });

  it("A isteğinin onayı B'ye uygulanamaz; id/tag karıştırma etkisizdir (bad_tag / unknown_id)", async () => {
    await boot();
    const a = await submit(w, NIGHT);
    const aApprove = a.msg!.actions[1]!.body;
    await w.ntfy.press(a.msg!, "Reddet"); await resultOf(w, a.pending!.id);
    w.clock.advance(LIMITS.cooldownMs + 1000);
    const b = await submit(w, ["mode", "off"]);
    expect(b.ack.status).toBe("pending");
    const [, , tagA] = aApprove.split(".");
    await waitFor(() => w.ntfy.connections.some((c) => c.topic === b.pending!.respTopic), "B'nin respTopic akışı");
    w.ntfy.emit(b.pending!.respTopic, `a1.${b.pending!.id}.${tagA}`); // B'nin id'si + A'nın tag'i
    w.ntfy.emit(b.pending!.respTopic, aApprove); // A'nın gövdesi aynen
    await waitFor(() => /bad_tag/.test(logText(w)) && /unknown_id/.test(logText(w)), "reddedilen yanıtların logu");
    await sleep(150);
    expect(w.exec.calls).toHaveLength(0);
    expect(w.store.readResult(b.pending!.id)).toBeNull(); // hâlâ bekliyor
  });

  it("aynı onay iki kez: tek çalıştırma; sonuçtan sonra tekrar oynatma (ve yeniden bağlanma) not_pending/unknown_id", async () => {
    await boot();
    const { pending: p, msg: m } = await submit(w, NIGHT);
    const body = await w.ntfy.press(m!, "Onayla");
    await resultOf(w, p!.id);
    await w.ntfy.press(m!, "Onayla");
    w.ntfy.emit(p!.respTopic, body);
    w.ntfy.dropStreams();
    await waitFor(() => w.ntfy.connections.length >= 2, "yeniden bağlanma", 10_000);
    await untilStream(w, 10_000);
    w.ntfy.emit(p!.respTopic, body);
    await waitFor(() => /not_pending|unknown_id/.test(logText(w)), "tekrar oynatma logu");
    await sleep(150);
    expect(w.exec.calls).toHaveLength(1);
  });

  it("digest alanlarından biri (ctx dahil) değişince tag geçersiz: golden varyantlarıyla", async () => {
    const { approveTag, computeDigest, parseDecision } = await import("../../src/approver/request.js");
    const g = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "approver", "golden-digest.json"), "utf8")) as { input: Parameters<typeof computeDigest>[0]; expected: string; variants: Record<string, string> };
    const mk = (digest: string, over: Record<string, unknown> = {}) => ({ v: 1 as const, shortId: g.input.id.slice(0, 8), cid: makeCid(), op: "mode night" as const, respTopic: "vlad-r-" + "a".repeat(26), keyGen: "0".repeat(16), status: "pending" as const, ...g.input, digest, ...over });
    const now = new Date();
    const live = (p: ReturnType<typeof mk>) => ({ ...p, requestedAt: new Date(now.getTime() - 1000).toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
    const base = live(mk(g.expected));
    const body = `a1.${base.id}.${approveTag(w.key, g.expected)}`;
    expect(parseDecision(body, base, w.key, now)).toEqual({ decision: "approve" });
    for (const [name, v] of Object.entries(g.variants)) {
      if (name === "base") continue;
      expect(approveTag(w.key, v), `${name}: tag farklı`).not.toBe(approveTag(w.key, g.expected));
      expect(parseDecision(body, live(mk(v)), w.key, now), `${name}: eski tag yeni özette geçmez`).toEqual({ drop: "bad_tag" });
    }
  });

  it("iki gövde tek chunk'ta (onay sonra ret ve ters): yalnız ilk geçerli karar tüketilir, çalıştırma ≤ 1", async () => {
    await boot();
    const a = await submit(w, NIGHT);
    w.ntfy.writeRaw(a.pending!.respTopic, w.ntfy.line(a.pending!.respTopic, a.msg!.actions[1]!.body) + w.ntfy.line(a.pending!.respTopic, a.msg!.actions[0]!.body));
    expect((await resultOf(w, a.pending!.id)).status).toBe("done");
    await sleep(150);
    expect(w.exec.calls).toHaveLength(1);

    w.clock.advance(LIMITS.cooldownMs + 1000);
    const b = await submit(w, ["mode", "off"]);
    w.ntfy.writeRaw(b.pending!.respTopic, w.ntfy.line(b.pending!.respTopic, b.msg!.actions[0]!.body) + w.ntfy.line(b.pending!.respTopic, b.msg!.actions[1]!.body));
    expect((await resultOf(w, b.pending!.id)).status).toBe("denied");
    await sleep(150);
    expect(w.exec.calls).toHaveLength(1); // ret önce geldi: ikinci çalıştırma yok
  });

  it("Reddet: denied, yürütücü çağrılmaz", async () => {
    await boot();
    const { pending: p, msg: m } = await submit(w, NIGHT);
    await w.ntfy.press(m!, "Reddet");
    expect((await resultOf(w, p!.id)).status).toBe("denied");
    expect(w.exec.calls).toHaveLength(0);
  });

  it("yürütme sürerken ikinci istek busy; onay yürütme sırasında tekrar çalıştırmaz", async () => {
    await boot();
    w.exec.hold();
    const a = await submit(w, NIGHT);
    await w.ntfy.press(a.msg!, "Onayla");
    await waitFor(() => w.exec.calls.length === 1, "yürütme başladı");
    const b = await submit(w, ["mode", "off"]);
    expect(b.ack.status).toBe("busy");
    await w.ntfy.press(a.msg!, "Onayla");
    await sleep(150);
    expect(w.exec.calls).toHaveLength(1);
    w.exec.release();
    expect((await resultOf(w, a.pending!.id)).status).toBe("done");
  });
});

describe("approver-kabul: KK4 süre dolumu", () => {
  it("TTL (5 dk) dolduktan sonra onay reddedilir (expired), çalıştırma yok; süresi dolan istek yenisini engellemez", async () => {
    await boot();
    const { pending: p, msg: m } = await submit(w, NIGHT);
    w.clock.advance(LIMITS.approveTtlMs + 1000);
    await w.ntfy.press(m!, "Onayla");
    await waitFor(() => /expired/.test(logText(w)), "expired logu");
    await sleep(150);
    expect(w.exec.calls).toHaveLength(0);
    const again = await submit(w, ["mode", "off"]);
    expect(again.ack.status, "süresi dolan bekleyen yeni isteği busy yapmamalı").toBe("pending");
    expect(p!.id).not.toBe(again.pending!.id);
  });

  it("TTL sınırı içinde (4 dk 59 sn) onay geçer", async () => {
    await boot();
    const { pending: p, msg: m } = await submit(w, NIGHT);
    w.clock.advance(LIMITS.approveTtlMs - 1000);
    await w.ntfy.press(m!, "Onayla");
    expect((await resultOf(w, p!.id)).status).toBe("done");
  });
});

describe("approver-kabul: KK5 yetkisiz yanıt etkisizdir", () => {
  it("bozuk gövde / yanlış id / yanlış tag: etkisiz + DropReason kodu loglanır, servis sağlam; sonra geçerli onay çalışır", async () => {
    await boot();
    const { pending: p, msg: m } = await submit(w, NIGHT);
    const goodTag = m!.actions[1]!.body.split(".")[2]!;
    w.ntfy.emit(p!.respTopic, "çöp gövde");
    w.ntfy.emit(p!.respTopic, `a1.${"b".repeat(26)}.${goodTag}`);
    w.ntfy.emit(p!.respTopic, `a1.${p!.id}.${"0".repeat(64)}`);
    w.ntfy.emit(p!.respTopic, "x".repeat(20_000));
    await waitFor(() => ["bad_format", "unknown_id", "bad_tag"].every((c) => logText(w).includes(c)), "drop kodları");
    expect(w.exec.calls).toHaveLength(0);
    expect(logText(w)).not.toContain("çöp gövde"); // gövde loglanmaz, yalnız kod
    expect(logText(w)).not.toContain("0".repeat(64));
    await w.ntfy.press(m!, "Onayla");
    expect((await resultOf(w, p!.id)).status).toBe("done");
  });

  it("başka/eski konuya POST ve bozuk NDJSON satırı: etkisiz, servis çökmez", async () => {
    const svc = startService(w); await untilWatching(w);
    const { pending: p, msg: m } = await submit(w, NIGHT);
    await fetch(`${w.cfg.server}/vlad-r-${"q".repeat(26)}`, { method: "POST", body: m!.actions[1]!.body });
    w.ntfy.writeRaw(p!.respTopic, "{bozuk json satırı\n");
    w.ntfy.writeRaw(p!.respTopic, "\n\n");
    await sleep(250);
    expect(w.exec.calls).toHaveLength(0);
    expect(svc.settled()).toBe(false);
  });
});

describe("approver-kabul: istemci–servis protokolü ve allowlist", () => {
  it("ack: cid'e göre yazılır; aynı cid ikinci kez yazılamaz (üzerine yazma yok); inbox sahiplenilince claimed'e geçer", async () => {
    await boot();
    const cid = makeCid();
    writeRequest(w, { argv: NIGHT, cid });
    expect(() => writeRequest(w, { argv: ["mode", "off"], cid })).toThrow();
    const ack = await waitAck(w, cid);
    expect(ack).toMatchObject({ v: 1, cid, status: "pending" });
    expect(dirFiles(join(w.dir, "inbox"))).not.toContain(`${cid}.json`);
    expect(dirFiles(join(w.dir, "claimed"))).toContain(`${cid}.json`);
  });

  const BAD: Array<[string, string[], RejectReason[] | null]> = [
    ["işlem dışı komut", ["bash", "-c", "id"], null],
    ["bilinmeyen bayrak", ["mode", "night", "--evil", "1"], null],
    ["tekrarlı bayrak", ["mode", "night", "--until", "23:00", "--until", "23:30"], ["duplicate_flag", "conflicting", "bad_flag"]],
    ["--x=y biçimi", ["mode", "night", "--until=23:00"], null],
    ["-- ayracı", ["mode", "night", "--", "--push"], null],
    ["-'li değer", ["mode", "night", "--note", "-rm"], null],
    ["NUL karakteri", ["mode", "night", "--note", "a\u0000b"], ["control_char", "bad_value"]],
    ["bidi karakteri", ["mode", "night", "--note", "a\u202Eb"], ["control_char", "bad_value"]],
    ["201 bayt değer (çok baytlı UTF-8, 101 karakter)", ["mode", "night", "--note", "ş".repeat(101)], ["too_large", "bad_value"]],
    ["düz setup", ["setup"], null],
    ["setup --answers", ["setup", "--answers", "x.json"], ["setup_answers_unsupported"]],
    ["setup --upgrade --answers", ["setup", "--upgrade", "--answers", "x.json"], ["setup_answers_unsupported", "bad_flag"]],
    ["setup bilinmeyen --confirm", ["setup", "--upgrade", "--confirm", "rm-rf-home"], null],
    ["install --dry-run", ["install", "--dry-run"], null],
    ["watch bilinmeyen değer", ["mode", "watch", "maybe"], null],
    ["until-task biçimi", ["mode", "night", "--until-task", "../../etc"], null],
  ];
  it.each(BAD)("geçersiz istek reddedilir (invalid), bildirim yayınlanmaz: %s", async (_n, argv, reasons) => {
    await boot();
    const before = w.ntfy.published.length;
    const cid = writeRequest(w, { argv });
    const ack = await waitAck(w, cid);
    expect(ack.status).toBe("invalid");
    expect(ack.reason).toBeTruthy();
    if (reasons) expect(reasons).toContain(ack.reason);
    await sleep(100);
    expect(w.ntfy.published.length).toBe(before);
    expect(w.store.readPending()).toBeNull();
  });

  it("izinli kenarlar geçer: boş --note, tam 200 bayt (çok baytlı) değer, setup --upgrade/--uninstall biçimleri, install --remove-menu, watch on|off", async () => {
    await boot();
    const ok: string[][] = [
      ["mode", "night", "--until", "23:00", "--note", ""],
      ["mode", "night", "--note", "ş".repeat(100)],
      ["setup", "--upgrade", "--only", "hooks", "--yes"],
      ["setup", "--uninstall", "hooks"],
      ["install", "--remove-menu"],
      ["mode", "watch", "on"],
      ["mode", "off"],
    ];
    for (const argv of ok) {
      const r = await submit(w, argv);
      expect(r.ack.status, argv.join(" ")).toBe("pending");
      await w.ntfy.press(r.msg!, "Onayla");
      expect((await resultOf(w, r.pending!.id)).status, argv.join(" ")).toBe("done");
      w.clock.advance(2 * 3_600_000); // soğuma + saatlik kota bu tablonun konusu değil (KK12 ayrı)
    }
    expect(w.exec.calls.map((c) => c.argv)).toEqual(ok);
  }, 60_000);

  it("setup bildirimi yapılandırılmış etki özeti verir (Yükseltme/Kapsam/Dış etki); --answers görünmez", async () => {
    await boot();
    const { msg: m } = await submit(w, ["setup", "--upgrade", "--only", "hooks,global-skills", "--yes", "--confirm", "agent-install"]);
    const lines = m!.message.split("\n");
    expect(lines[0]).toBe("Yükseltme: hooks, global-skills");
    expect(lines[1]).toBe("Kapsam: hooks,global-skills");
    expect(lines[2]).toMatch(/^Dış etki: .*agent-install/);
    expect(SECRET_PATTERNS.find((x) => x.name.startsWith("--answers"))!.re.test(m!.message)).toBe(false);
  });

  it("anahtar kapalıyken (mode token --disable) yeni istek invalid:key_disabled", async () => {
    await boot();
    // `mode token --disable` secretDir'i (approver/ dahil) siler; servisin gördüğü durum keyState≠ok. approver/ ayakta kalsın diye anahtarı bozuyoruz (geniş izin ⇒ broken).
    chmodSync(join(w.secret, "mode.key"), 0o644);
    const cid = writeRequest(w, { argv: NIGHT });
    const ack = await waitAck(w, cid);
    expect(ack).toMatchObject({ status: "invalid", reason: "key_disabled" });
    expect(w.ntfy.published).toHaveLength(0);
  });
});
