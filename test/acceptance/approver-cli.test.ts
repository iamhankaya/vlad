import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "../../src/approver/types.js";
import { secretHits, SECRET_PATTERNS } from "../support/approver-secrets.js";
import { spawnVlad } from "../support/spawn-vlad.js";
import { dirFiles, makeWorld, resultOf, runVlad, sleep, startService, submit, untilWatching, waitFor, logText } from "./approver-harness.js";
import type { World } from "./approver-harness.js";

// approver-kabul: `vlad mode request` (hata sırası, --wait, çıktı), `approver status|requests|show`, install TTY reddi, belge.
// `mode request` süreç içi çalışır (gerçek servis döngüsü aynı süreçte, sahte ntfy); install yalnız ÇOCUK süreçte ve PATH'te sahte launchctl ile.
let w: World;
const cwd0 = process.cwd();
beforeEach(async () => { w = await makeWorld(); process.chdir(w.vladHome); });
afterEach(async () => { process.chdir(cwd0); await w.dispose(); });
const ENV = { VLAD_TASK_ID: undefined as string | undefined, VLAD_MODE_TOKEN: undefined as string | undefined };
const request = (args: string[], env: Record<string, string | undefined> = ENV) => runVlad(["mode", "request", ...args], { env });
const err = (r: { err: string }): { error: string; details?: unknown } => { try { return JSON.parse(r.err.trim().split("\n").pop() ?? "{}"); } catch { return { error: r.err }; } };

describe("approver-kabul: `mode request` hata öncelik sırası", () => {
  beforeEach(() => { rmSync(join(w.dir, "channel.json"), { force: true }); });
  it("(1) çalışan + kurulu değil ⇒ çalışan hatası", async () => {
    const r = await request(["night", "--until", "23:00"], { ...ENV, VLAD_TASK_ID: "T20261116-99" });
    expect(r.code).toBe(1);
    expect(err(r).error).toMatch(/çalışan oturumu uzaktan onay isteği yazamaz/);
    expect(dirFiles(join(w.dir, "inbox"))).toEqual([]);
  });
  it("(2) geçersiz argüman + kurulu değil ⇒ argüman hatası", async () => {
    const r = await request(["bash", "-c", "id"]);
    expect(r.code).toBe(1);
    expect(err(r).error).toMatch(/geçersiz işlem\/argüman/);
    const r2 = await request(["night", "--evil"]);
    expect(err(r2).error).toMatch(/geçersiz işlem\/argüman/);
  });
  it("(3) geçerli + kurulu değil ⇒ `approver kurulu değil`", async () => {
    const r = await request(["night", "--until", "23:00"]);
    expect(r.code).toBe(1);
    expect(err(r).error).toMatch(/approver kurulu değil: önce terminalde vlad approver install/);
    expect(dirFiles(join(w.dir, "inbox"))).toEqual([]);
  });
});

describe("approver-kabul: `mode request` komut satırı ayrıştırması (sözleşme iskeleti)", () => {
  // İşlemin argümanları (`--until`, `-c` …) `request <op> [args...]` içine HAM geçmeli; bayraklar yalnız işlemden ÖNCE komutun kendisine ait (passThroughOptions).
  it.each([[["night", "--until", "23:00"]], [["bash", "-c", "id"]], [["--json", "night", "--until", "23:00"]], [["setup", "--upgrade", "--only", "hooks", "--yes"]], [["--wait-seconds", "2", "install", "--remove-menu"]]])(
    "işlemden sonraki bayraklar Commander'da 'unknown option' hatası vermez: %j", async (args) => {
      rmSync(join(w.dir, "channel.json"), { force: true });
      const r = await request(args);
      expect(r.err).not.toMatch(/unknown option|bilinmeyen (seçenek|bayrak)/i);
    });
});

describe("approver-kabul: `mode request` servis ile", () => {
  it("(4) kurulu ama servis yok ⇒ 15 sn sonra `approver yanıt vermiyor`; inbox dosyası temizlenir", async () => {
    const r = await request(["night", "--until", "23:00"]);
    expect(r.code).toBe(1);
    expect(err(r).error).toMatch(/approver yanıt vermiyor: servis çalışıyor olmayabilir|approver yanıt vermiyor: servis çalışmıyor olabilir/);
    expect(err(r).error).toMatch(/vlad approver status/);
    expect(dirFiles(join(w.dir, "inbox"))).toEqual([]);
  }, 40_000);

  it("başarı: {id, status:\"pending\", expiresAt}; id servisin id'si; bildirim gider; çıktıda sır yok; channel.json içeriği okunmaz", async () => {
    startService(w); await untilWatching(w);
    writeFileSync(join(w.dir, "channel.json"), "{{{ bozuk: istemci yalnız lstat ile varlığına bakar", { mode: 0o600 });
    const r = await request(["--json", "night", "--until", "23:00", "--note", "gece"]);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { id: string; status: string; expiresAt: string };
    expect(j.status).toBe("pending");
    expect(j.id).toMatch(/^[a-z2-7]{26}$/);
    expect(Date.parse(j.expiresAt)).toBe(Date.parse(w.store.readPending()!.expiresAt));
    expect(w.store.readPending()!.id).toBe(j.id);
    expect(w.store.readPending()!.requester).toMatch(/\S/);
    await waitFor(() => w.ntfy.requests.length === 1, "bildirim");
    expect(secretHits(r.out + r.err)).toEqual([]);
  });

  it("servis ack'leri kullanıcıya düz Türkçe: key_disabled / busy / hız sınırı / kilit", async () => {
    startService(w); await untilWatching(w);
    const first = await request(["night", "--until", "23:00"]);
    expect(first.code, first.err).toBe(0);
    const busy = await request(["off"]);
    expect(busy.code).toBe(1);
    expect(err(busy).error).toMatch(/meşgul: bekleyen istek var \([a-z2-7]{8}\)/);
    const id = w.store.readPending()!.id;
    await w.ntfy.press(w.ntfy.requests[0]!, "Onayla");
    await resultOf(w, id);
    const rl = await request(["off"]);
    expect(err(rl).error).toMatch(/hız sınırı/);
    w.clock.advance(LIMITS.cooldownMs + 1000);
    // `mode token --disable` gizli dizini (approver/ dahil) siler; o durumda "kurulu değil" doğru mesajdır. Burada approver/ ayakta, anahtar bozuk (keyState≠ok):
    chmodSync(join(w.secret, "mode.key"), 0o644);
    const kd = await request(["off"]);
    expect(err(kd).error).toMatch(/mod belirteci etkin değil: önce vlad mode token/);
  }, 45_000);

  it("--wait --wait-seconds 2: sonuç yoksa çıkış 1 ve {status:\"wait_timeout\", id}; istek iptal EDİLMEZ, sonra onaylanınca çalışır", async () => {
    startService(w); await untilWatching(w);
    const r = await request(["--wait", "--wait-seconds", "2", "--json", "night", "--until", "23:00"]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out) as { status: string; id: string };
    expect(j.status).toBe("wait_timeout");
    const p = w.store.readPending()!;
    expect(p.id).toBe(j.id); expect(p.status).toBe("pending");
    await w.ntfy.press(w.ntfy.requests[0]!, "Onayla");
    expect((await resultOf(w, j.id)).status).toBe("done");
    expect(w.exec.calls).toHaveLength(1);
  }, 30_000);

  it("--wait: sonuç `done` ise çıkış 0; ret ise çıkış 1", async () => {
    startService(w); await untilWatching(w);
    const run = request(["--wait", "--wait-seconds", "20", "--json", "night", "--until", "23:00"]);
    await waitFor(() => w.ntfy.requests.length === 1, "bildirim");
    await w.ntfy.press(w.ntfy.requests[0]!, "Onayla");
    const ok = await run;
    expect(ok.code, ok.err).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ status: "done" });
    w.clock.advance(LIMITS.cooldownMs + 1000);
    const run2 = request(["--wait", "--wait-seconds", "20", "--json", "off"]);
    await waitFor(() => w.ntfy.requests.length === 2, "ikinci bildirim");
    await w.ntfy.press(w.ntfy.requests[1]!, "Reddet");
    const no = await run2;
    expect(no.code).toBe(1);
    expect(JSON.parse(no.out)).toMatchObject({ status: "denied" });
  }, 45_000);
});

describe("approver-kabul: approver status | requests | show (salt okuma, sızıntısız)", () => {
  it("status/requests/show çıktıları konu, nonce, tag, anahtar, token içermez; show NAME_RE ile traversal'ı reddeder", async () => {
    startService(w); await untilWatching(w);
    const { pending: p, msg } = await submit(w, ["mode", "night", "--until", "23:00", "--note", "gizli-not ".repeat(6).trim()]);
    await w.ntfy.press(msg!, "Onayla");
    await resultOf(w, p!.id);
    const tag = msg!.actions[1]!.body.split(".")[2]!;
    const token = w.exec.calls[0]!.token;
    const outs = await Promise.all([
      runVlad(["approver", "status", "--json"], { env: ENV }), runVlad(["approver", "requests", "--json"], { env: ENV }),
      runVlad(["approver", "requests", "--json", "--limit", "1"], { env: ENV }), runVlad(["approver", "show", p!.id, "--json"], { env: ENV }),
    ].map((x) => x));
    for (const o of outs) {
      expect(o.code, o.err).toBe(0);
      const text = o.out.split(p!.digest).join("<digest>");
      expect(secretHits(text), o.out).toEqual([]);
      for (const bad of [w.key, p!.nonce, tag, token, p!.respTopic, w.cfg.requestTopic]) expect(text).not.toContain(bad);
      JSON.parse(o.out);
    }
    const list = JSON.parse(outs[1]!.out);
    expect(JSON.stringify(list)).toContain(p!.id);
    expect(JSON.stringify(list)).toMatch(/done/);
    expect(JSON.stringify(JSON.parse(outs[3]!.out))).toContain("mode");
    expect(JSON.stringify(JSON.parse(outs[3]!.out))).toContain("vlad-07");
    for (const bad of ["../../etc/passwd", "ABC", "a".repeat(27), "..%2f"]) {
      const r = await runVlad(["approver", "show", bad], { env: ENV });
      expect(r.code, bad).toBe(1);
    }
    expect(logText(w)).not.toContain(token);
  });

  it("status servis yokken de çalışır (salt okuma) ve kurulu değilken bunu söyler", async () => {
    rmSync(join(w.dir, "channel.json"), { force: true });
    // Sahte installer: gerçek launchd durumuna (makinede approver kurulu/çalışıyor olabilir) bağlı kalma (F-vlad-355 sınıfı).
    const notInstalled = { install: async () => [], uninstall: async () => [], status: async () => ({ installed: false, running: false, detail: "kurulu değil" }) };
    const r = await runVlad(["approver", "status", "--json"], { env: ENV, approverDeps: { installer: notInstalled } });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ installed: false, running: false });
  });
});

describe("approver-kabul: KK10 install/uninstall yalnız TTY + mod yetkisi + çalışan değil (çocuk süreç, sahte launchctl)", () => {
  it.each([["install"], ["uninstall"], ["rotate"], ["unlock"]])("`approver %s` TTY'siz reddedilir; launchctl ÇAĞRILMAZ; abonelik URL'si basılmaz", (cmd) => {
    const bin = join(w.root, "bin"); mkdirSync(bin);
    const log = join(w.root, "launchctl.log");
    writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "$@" >> '${log}'\nexit 0\n`);
    chmodSync(join(bin, "launchctl"), 0o755);
    const r = spawnVlad({ args: ["approver", cmd], cwd: w.vladHome, env: { PATH: `${bin}:${process.env.PATH}`, VLAD_HOME: w.vladHome, VLAD_TEST_SECRET_DIR: w.secret } });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/TTY|terminal|VLAD_MODE_TOKEN/);
    expect(existsSync(log), "launchctl çağrıldı").toBe(false);
    expect(r.stdout + r.stderr).not.toMatch(/vlad-q-[a-z2-7]{26}/);
    expect(existsSync(join(w.dir, "channel.json")), "uninstall/rotate etkisiz").toBe(true);
  });
  it("`approver run` yardımda launchd girişi olarak işaretli", () => {
    const h = spawnVlad({ args: ["approver", "run", "--help"], cwd: w.vladHome, env: { VLAD_HOME: w.vladHome, VLAD_TEST_SECRET_DIR: w.secret } });
    expect(h.stdout).toMatch(/launchd/);
  });
});

describe("approver-kabul: tek sayfa kurulum belgesi (docs/uzaktan-onay.md)", () => {
  const doc = (): string => readFileSync(resolve(import.meta.dirname, "..", "..", "docs", "uzaktan-onay.md"), "utf8");
  it("belge var; başta aynı-UID sınırı ve ntfy güven notu; install/rotate/uninstall/unlock/status, nota sır yazma, sorun giderme", () => {
    const d = doc();
    expect(d.slice(0, 2500)).toMatch(/UID/);
    expect(d.slice(0, 2500)).toMatch(/kimlik doğrulama(sı)? değil/i);
    for (const k of ["vlad approver install", "vlad approver rotate", "vlad approver uninstall", "vlad approver unlock", "vlad approver status", "vlad mode request", "sorun giderme"]) expect(d.toLowerCase(), k).toContain(k.toLowerCase());
    expect(d).toMatch(/nota sır/i);
    expect(d).toMatch(/ntfy/);
    expect(d).toMatch(/kapsam dışı|Windows/i);
  });
  it("tek sayfa: mod belirteci belgesi uzaktan onay belgesine bağlanır; belge gizli konu/anahtar örneği içermez", () => {
    expect(readFileSync(resolve(import.meta.dirname, "..", "..", "docs", "mod-belirteci-etkinlestirme.md"), "utf8")).toContain("uzaktan-onay.md");
    const d = doc();
    expect(SECRET_PATTERNS.filter((p) => p.name.startsWith("mode.key") && p.re.test(d)).map((p) => p.name)).toEqual([]);
  });
});

void sleep;
