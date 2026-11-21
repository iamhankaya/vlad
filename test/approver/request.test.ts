import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveTag, computeDigest, denyTag, keyGen, newId, newNonce, newTopic, parseDecision, renderNotification, validateRequest } from "../../src/approver/request.js";
import type { PendingRecord } from "../../src/approver/types.js";
import { secretHits } from "../support/approver-secrets.js";

const fx = join(import.meta.dirname, "..", "fixtures", "approver");
const json = (f: string) => JSON.parse(readFileSync(join(fx, f), "utf8"));

const CID = "a".repeat(26);
const opOf = (argv: string[]) => (argv[0] === "mode" ? `mode ${argv[1]}` : argv[0] ?? "install") as string;
const mk = (argv: string[], over: Record<string, unknown> = {}) => ({ v: 1, cid: CID, op: opOf(argv), argv, requestedAt: "2026-11-16T14:20:00+03:00", requester: "vlad-07", ...over });
const reason = (raw: unknown) => { const r = validateRequest(raw); return r.ok ? "ok" : r.reason; };
const argvReason = (argv: string[]) => reason(mk(argv));

describe("approver: validateRequest zarf", () => {
  it("geçerli isteği aynen döndürür", () => {
    const raw = mk(["mode", "off"]);
    const r = validateRequest(raw);
    expect(r).toEqual({ ok: true, req: raw });
  });
  it("istekteki title/message/nonce/id/respTopic/tag/topic alanları yok sayılır (kullanılmaz, çıktıya girmez); diğer bilinmeyen alan reddedilir", () => {
    const raw = mk(["mode", "off"]);
    const r = validateRequest({ ...raw, title: "T", message: "M", nonce: "f".repeat(32), id: "z".repeat(26), respTopic: "vlad-r-x", tag: "e".repeat(64), topic: "vlad-q-x" });
    expect(r).toEqual({ ok: true, req: raw });
  });
  it("şekil bozuklukları bad_value; bilinmeyen alan ve op uyuşmazlığı reddedilir", () => {
    for (const bad of [null, "x", 5, [], {}, mk(["mode", "off"], { v: 2 }), mk(["mode", "off"], { cid: "ABC" }), mk(["mode", "off"], { cid: "../../etc" }), mk(["mode", "off"], { argv: "mode off" }),
      mk(["mode", "off"], { argv: ["mode", 5] }), mk(["mode", "off"], { requestedAt: "dün" }), mk(["mode", "off"], { requester: "" }), mk(["mode", "off"], { requester: "x".repeat(65) }), mk(["mode", "off"], { extra: 1 })])
      expect(reason(bad), JSON.stringify(bad)).toBe("bad_value");
    expect(reason(mk(["mode", "off"], { op: "install" }))).toBe("not_allowlisted");
    expect(reason(mk(["mode", "off"], { op: "rm -rf" }))).toBe("not_allowlisted");
  });
  it("requester'da kontrol karakteri control_char", () => { expect(reason(mk(["mode", "off"], { requester: "a\nb" }))).toBe("control_char"); });
  it("detail değeri yansıtmaz (sır/gövde sızmaz)", () => {
    const r = validateRequest(mk(["mode", "night", "--note", "SECRET-SENTINEL-1\u0000"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).not.toContain("SECRET-SENTINEL");
  });
});

describe("approver: allowlist (mode/install)", () => {
  it("izinli biçimler", () => {
    for (const argv of [
      ["mode", "off"], ["mode", "watch", "on"], ["mode", "watch", "off"], ["install"], ["install", "--remove-menu"], ["mode", "night"],
      ["mode", "night", "--until", "23:00", "--note", "gece işi"], ["mode", "night", "--until", "2026-11-16T23:00:00+03:00", "--push"],
      ["mode", "night", "--until-task", "T20261116-06,T20261116-07", "--except", "deploy,keychain", "--projects", "vlad,my.proj-2"],
    ]) expect(argvReason(argv), argv.join(" ")).toBe("ok");
  });
  it("izinsiz komut/op not_allowlisted", () => {
    for (const argv of [["mode", "token", "--reset"], ["task", "nope"], ["mode", "watch"], ["mode", "watch", "maybe"], ["mode"], [], ["uninstall"]])
      expect(argvReason(argv), argv.join(" ")).toBe("not_allowlisted");
  });
  it("bilinmeyen bayrak/yardımcı/pozisyonel/-- ve --x=y bad_flag", () => {
    for (const argv of [["mode", "night", "--evil"], ["mode", "night", "--"], ["mode", "night", "--push=1"], ["mode", "night", "--until=23:00"], ["mode", "night", "stray"], ["mode", "off", "--push"], ["install", "--dry-run"], ["install", "--yes"], ["mode", "night", "-p"]])
      expect(argvReason(argv), argv.join(" ")).toBe("bad_flag");
  });
  it("tekrarlanan bayrak duplicate_flag", () => {
    expect(argvReason(["mode", "night", "--push", "--push"])).toBe("duplicate_flag");
    expect(argvReason(["mode", "night", "--note", "a", "--note", "b"])).toBe("duplicate_flag");
  });
  it("boş --note izinli (plan KK7); diğer bayraklarda boş değer bad_value", () => {
    expect(argvReason(["mode", "night", "--note", ""])).toBe("ok");
    expect(argvReason(["mode", "night", "--until", ""])).toBe("bad_value");
  });
  it("boş, eksik ve '-' ile başlayan değer bad_value", () => {
    for (const argv of [["mode", "night", "--note"], ["mode", "night", "--until"], ["mode", "night", "--note", "-x"], ["mode", "night", "--until", "--push"]])
      expect(argvReason(argv), argv.join("|")).toBe("bad_value");
  });
  it("değer biçimleri", () => {
    for (const argv of [["mode", "night", "--until", "25:99x"], ["mode", "night", "--until", "yarın"], ["mode", "night", "--until-task", "T1,x"], ["mode", "night", "--until-task", "T20261116-06,"],
      ["mode", "night", "--except", "Deploy"], ["mode", "night", "--except", "a,,b"], ["mode", "night", "--projects", "a b"], ["mode", "night", "--projects", "../x/y"],
      ["mode", "night", "--projects", "."], ["mode", "night", "--projects", ".."], ["mode", "night", "--projects", ".hidden"], ["mode", "night", "--projects", "a,.."], ["mode", "night", "--projects", "a,.git"]])
      expect(argvReason(argv), argv.join("|")).toBe("bad_value"); // F-vlad-346(a): nokta/noktayla başlayan proje adı yok
  });
  it("kontrol/NUL/bidi karakterleri control_char (not dahil, subcommand dahil)", () => {
    for (const c of ["\u0000", "\n", "\t", "\u001b", "\u007f", "\u202e", "\u2066", "\u200f", "\u2028"])
      expect(argvReason(["mode", "night", "--note", `a${c}b`]), JSON.stringify(c)).toBe("control_char");
    expect(argvReason(["mode\u0000", "off"])).toBe("control_char");
  });
  it("UTF-8 bayt ölçüsü: tek değer 60 geçer, 61 ret (ş = 2 bayt; D-vlad-084)", () => {
    expect(argvReason(["mode", "night", "--note", "a".repeat(60)])).toBe("ok");
    expect(argvReason(["mode", "night", "--note", "a".repeat(61)])).toBe("too_large");
    expect(argvReason(["mode", "night", "--note", "ş".repeat(30)])).toBe("ok"); // 60 bayt
    expect(argvReason(["mode", "night", "--note", "ş".repeat(30) + "a"])).toBe("too_large"); // 61 bayt
    expect(argvReason(["mode", "night", "--note", "a".repeat(59) + "ş"])).toBe("too_large"); // 61 bayt, çok baytlı sınırda
  });
  it("toplam JSON.stringify(argv) baytı: 8192 sınırı geçer (başka nedenle reddedilir), 8193 too_large", () => {
    const sized = (n: number): string[] => { // JSON baytı tam n olan argv: ["mode", "night", ...dolgu]
      const a = ["mode", "night"]; let size = Buffer.byteLength(JSON.stringify(a));
      while (n - size > 0) { const room = n - size - 1 /* virgül */ - 2 /* tırnaklar */; const len = Math.min(100, room); a.push("z".repeat(len)); size = Buffer.byteLength(JSON.stringify(a)); }
      return a;
    };
    const ok = sized(8192), big = sized(8193);
    expect(Buffer.byteLength(JSON.stringify(ok))).toBe(8192);
    expect(Buffer.byteLength(JSON.stringify(big))).toBe(8193);
    expect(argvReason(ok)).not.toBe("too_large");
    expect(argvReason(big)).toBe("too_large");
  });
});

describe("approver: allowlist (setup)", () => {
  it("izinli iki biçim", () => {
    expect(argvReason(["setup", "--upgrade"])).toBe("ok");
    expect(argvReason(["setup", "--upgrade", "--yes", "--confirm", "agent-install,permissions-write"])).toBe("ok");
    for (const p of ["hooks", "global-skills", "config"]) expect(argvReason(["setup", "--uninstall", p]), p).toBe("ok");
  });
  it("--answers ve düz setup setup_answers_unsupported", () => {
    for (const argv of [["setup"], ["setup", "--answers", "a.json"], ["setup", "--upgrade", "--answers", "a.json"], ["setup", "--yes"], ["setup", "--only", "hooks"], ["setup", "--confirm", "keygen"]])
      expect(argvReason(argv), argv.join(" ")).toBe("setup_answers_unsupported");
  });
  it("--dry-run, çelişen/yanlış biçimler", () => {
    expect(argvReason(["setup", "--upgrade", "--dry-run"])).toBe("bad_flag");
    expect(argvReason(["setup", "--check"])).toBe("bad_flag");
    expect(argvReason(["setup", "--uninstall"])).toBe("bad_value");
    expect(argvReason(["setup", "--uninstall", "agent"])).toBe("bad_value");
    expect(argvReason(["setup", "--uninstall", "hooks", "--yes"])).toBe("bad_flag");
    expect(argvReason(["setup", "--upgrade", "--uninstall", "hooks"])).toBe("conflicting");
    // --only uzaktan reddedilir: runUpgrade parça seçimini uygulamaz (cli+global-skills+hooks hepsi)
    for (const only of [["hooks"], ["hooks,global-skills"], ["yok"], ["hooks,,config"]]) expect(argvReason(["setup", "--upgrade", "--only", ...only]), only[0]).toBe("bad_flag");
    expect(argvReason(["setup", "--upgrade", "--yes", "--only", "hooks"])).toBe("bad_flag");
    for (const v of ["hooks,config", "hooks,global-skills", "cli"]) expect(argvReason(["setup", "--uninstall", v]), v).toBe("bad_value"); // tek hedef
    expect(argvReason(["setup", "--upgrade", "--confirm", "rm-rf"])).toBe("bad_value");
    expect(argvReason(["setup", "--upgrade", "--yes", "--yes"])).toBe("duplicate_flag");
  });
});

describe("approver: digest/tag/keyGen", () => {
  const g = json("golden-digest.json");
  it("golden digest ve değişkenler birebir", () => {
    expect(computeDigest(g.input)).toBe(g.expected);
    expect(computeDigest({ ...g.input, argv: [...g.input.argv.slice(0, 2)] })).not.toBe(g.expected);
  });
  it("her alan digest'e girer", () => {
    const base = computeDigest(g.input);
    const muts: Array<Partial<typeof g.input>> = [{ id: "a".repeat(26) }, { argv: ["install"] }, { requestedAt: "x" }, { expiresAt: "x" }, { nonce: "f".repeat(32) }, { requester: "x" },
      { ctx: { ...g.input.ctx, home: "/h" } }, { ctx: { ...g.input.ctx, kb: "/k" } }, { ctx: { ...g.input.ctx, cli: "/c" } }];
    for (const m of muts) expect(computeDigest({ ...g.input, ...m }), JSON.stringify(m)).not.toBe(base);
  });
  const key = "ab".repeat(32);
  const mac = (s: string) => createHmac("sha256", Buffer.from(key, "hex")).update(s, "utf8").digest("hex");
  it("approve/deny/keyGen formülleri (bağımsız hesap)", () => {
    expect(approveTag(key, g.expected)).toBe(mac("VLAD-APPROVE1|" + g.expected));
    expect(denyTag(key, g.expected)).toBe(mac("VLAD-DENY1|" + g.expected));
    expect(approveTag(key, g.expected)).not.toBe(denyTag(key, g.expected));
    expect(keyGen(key)).toBe(mac("VLAD-GEN1").slice(0, 16));
    expect(keyGen(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyGen("cd".repeat(32))).not.toBe(keyGen(key));
  });
  it("digest saf SHA-256 (bağımsız)", () => {
    const i = g.input;
    expect(computeDigest(i)).toBe(createHash("sha256").update(JSON.stringify(["VLAD-APPROVE1", i.id, i.argv, i.requestedAt, i.expiresAt, i.nonce, i.requester, i.ctx.home, i.ctx.kb, i.ctx.cli])).digest("hex"));
  });
});

describe("approver: parseDecision", () => {
  const key = "ab".repeat(32);
  const base = json("golden-notification-night.json").pending as PendingRecord;
  const p: PendingRecord = { ...base, digest: computeDigest(base) };
  const now = new Date("2026-11-16T14:21:00+03:00");
  const a = `a1.${p.id}.${approveTag(key, p.digest)}`;
  const d = `d1.${p.id}.${denyTag(key, p.digest)}`;
  it("geçerli onay/ret", () => {
    expect(parseDecision(a, p, key, now)).toEqual({ decision: "approve" });
    expect(parseDecision(d, p, key, now)).toEqual({ decision: "deny" });
  });
  it("bad_format", () => {
    for (const b of ["", "x", `A1.${p.id}.${"0".repeat(64)}`, `a1.${p.id}.${"0".repeat(63)}`, `a1.${p.id}.${"G".repeat(64)}`, `${a}\n`, ` ${a}`, `a2.${p.id}.${"0".repeat(64)}`, `a1.${p.id}.${"0".repeat(64)}.x`])
      expect(parseDecision(b, p, key, now), JSON.stringify(b)).toEqual({ drop: "bad_format" });
  });
  it("oversize", () => { expect(parseDecision("a".repeat(1000), p, key, now)).toEqual({ drop: "oversize" }); });
  it("unknown_id / not_pending / expired / bad_tag", () => {
    expect(parseDecision(`a1.${"b".repeat(26)}.${approveTag(key, p.digest)}`, p, key, now)).toEqual({ drop: "unknown_id" });
    expect(parseDecision(a, { ...p, status: "approved" }, key, now)).toEqual({ drop: "not_pending" });
    expect(parseDecision(a, p, key, new Date("2026-11-16T14:25:00+03:00"))).toEqual({ drop: "expired" });
    expect(parseDecision(a, p, key, new Date("2026-11-16T14:24:59+03:00"))).toEqual({ decision: "approve" });
    expect(parseDecision(`a1.${p.id}.${"0".repeat(64)}`, p, key, now)).toEqual({ drop: "bad_tag" });
    expect(parseDecision(`a1.${p.id}.${denyTag(key, p.digest)}`, p, key, now)).toEqual({ drop: "bad_tag" }); // ret etiketi onay için geçmez
    expect(parseDecision(`d1.${p.id}.${approveTag(key, p.digest)}`, p, key, now)).toEqual({ drop: "bad_tag" });
    expect(parseDecision(a, p, "cd".repeat(32), now)).toEqual({ drop: "bad_tag" });
  });
  it("tag başka isteğin digest'ine bağlı: başka isteğe uygulanamaz", () => {
    const other = { ...p, digest: computeDigest({ ...base, nonce: "f".repeat(32) }) };
    expect(parseDecision(a, other, key, now)).toEqual({ drop: "bad_tag" });
  });
  it("geçersiz expiresAt: expired (fail-closed)", () => { expect(parseDecision(a, { ...p, expiresAt: "bozuk" }, key, now)).toEqual({ drop: "expired" }); });
});

describe("approver: renderNotification golden (TZ=Europe/Istanbul, HOME=/Users/test)", () => {
  const savedTz = process.env.TZ, savedHome = process.env.HOME, savedProfile = process.env.USERPROFILE; // os.homedir() Windows'ta USERPROFILE okur (HOME değil): ikisi birlikte ayarlanır/geri alınır
  afterEach(() => { for (const [k, v] of [["TZ", savedTz], ["HOME", savedHome], ["USERPROFILE", savedProfile]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const names = readdirSync(fx).filter((f) => f.startsWith("golden-notification-")).sort();
  it("ek golden'lar mevcut", () => { expect(names).toEqual(expect.arrayContaining(["golden-notification-note-trunc.json", "golden-notification-argv-trunc.json"])); });
  for (const f of names) {
    it(`${f}: birebir`, () => {
      const g = json(f);
      process.env.TZ = g.tz; process.env.HOME = process.env.USERPROFILE = g.homedir;
      const r = renderNotification(g.pending);
      expect(r).toEqual(g.expected);
      expect(secretHits(r.message, { allowTopic: true })).toEqual([]);
      expect(r.message).not.toContain(g.homedir);
    });
  }
  it("uzak saat dilimi: yerel saat farklı çıkar (TZ gerçekten uygulanır)", () => {
    const g = json("golden-notification-night.json");
    process.env.TZ = "UTC"; process.env.HOME = process.env.USERPROFILE = g.homedir;
    expect(renderNotification(g.pending).message).toContain("İstek: 11:20:00 · Geçerli: 11:25:00");
  });
  it("--note alıntılı ve kesilmeden tam görünür (bildirimdeki not = kaydedilen not; D-vlad-084)", () => {
    const g = json("golden-notification-night.json"); process.env.TZ = g.tz; process.env.HOME = process.env.USERPROFILE = g.homedir;
    const note = "ş".repeat(30), argv = ["mode", "night", "--note", note];
    expect(validateRequest({ v: 1, cid: "a".repeat(26), op: "mode night", argv, requestedAt: "2026-11-16T14:20:00+03:00", requester: "r" }).ok).toBe(true);
    const m = renderNotification({ ...g.pending, argv }).message;
    expect(m).toContain(`--note "${note}"\n`); expect(m).not.toContain("…");
    expect(renderNotification({ ...g.pending, argv: ["mode", "night", "--note", "a".repeat(60)] }).message).toContain(`--note "${"a".repeat(60)}"\n`);
  });
  it("her bayrak bildirimde ayrı satır olarak tam görünür (sondaki --push/--except/--until dahil)", () => {
    const g = json("golden-notification-night.json"); process.env.TZ = g.tz; process.env.HOME = process.env.USERPROFILE = g.homedir;
    const argv = ["mode", "night", "--until-task", "T20261116-10", "--projects", "a,b", "--note", "x", "--push", "--except", "foo,bar", "--until", "23:00"];
    expect(validateRequest({ v: 1, cid: "a".repeat(26), op: "mode night", argv, requestedAt: "2026-11-16T14:20:00+03:00", requester: "r" }).ok).toBe(true);
    const lines = renderNotification({ ...g.pending, argv }).message.split("\n");
    expect(lines.slice(0, 7)).toEqual(["İşlem: vlad mode night", "--until-task T20261116-10", "--projects a,b", '--note "x"', "--push", "--except foo,bar", "--until 23:00"]);
    expect(renderNotification({ ...g.pending, op: "install", argv: ["install", "--remove-menu"] }).message.split("\n").slice(0, 2)).toEqual(["İşlem: vlad install", "--remove-menu"]);
  });
  it("setup --yes ayrı satır; --yes yoksa satır yok", () => {
    const g = json("golden-notification-setup-upgrade.json"); process.env.TZ = g.tz; process.env.HOME = process.env.USERPROFILE = g.homedir;
    expect(renderNotification(g.pending).message.split("\n")).toContain("Bayrak: --yes");
    expect(renderNotification({ ...g.pending, argv: ["setup", "--upgrade"] }).message).not.toContain("--yes");
  });
  it("bildirime sığmayan istek too_large (kırpma yok)", () => {
    const mk = (argv: string[]) => validateRequest({ v: 1, cid: "a".repeat(26), op: "mode night", argv, requestedAt: "2026-11-16T14:20:00+03:00", requester: "r" });
    const t = Array.from({ length: 16 }, (_, i) => `T20261116-${10 + i}`).join(",");
    const slugs = Array.from({ length: 4 }, () => "a".repeat(40)).join(",");
    expect(mk(["mode", "night", "--until-task", t, "--projects", "p".repeat(190), "--except", slugs, "--note", "n".repeat(100), "--push"])).toMatchObject({ ok: false, reason: "too_large" });
    expect(mk(["mode", "night", "--projects", "p".repeat(190)]).ok).toBe(true);
  });
  it("setup uninstall ve çıplak upgrade biçimleri; confirm yoksa 'yok'", () => {
    const g = json("golden-notification-setup-upgrade.json"); process.env.TZ = g.tz; process.env.HOME = process.env.USERPROFILE = g.homedir;
    const un = renderNotification({ ...g.pending, argv: ["setup", "--uninstall", "hooks"] }).message;
    expect(un.split("\n")[0]).toBe("Geri alma: hooks");
    expect(un).toContain("Dış etki: yok");
    const up = renderNotification({ ...g.pending, argv: ["setup", "--upgrade"] }).message;
    expect(up.split("\n")[0]).toMatch(/^Yükseltme: /);
  });
  it("hedef $HOME dışındaysa mutlak kalır; yalnız tam önek (/Users/test2) kısaltılmaz", () => {
    const g = json("golden-notification-night.json"); process.env.TZ = g.tz; process.env.HOME = process.env.USERPROFILE = g.homedir;
    const m = renderNotification({ ...g.pending, ctx: { ...g.pending.ctx, home: "/Users/test2/x", kb: "/opt/kb" } }).message;
    expect(m).toContain("Hedef: /Users/test2/x | kb: /opt/kb");
  });
});

describe("approver: rastgelelik", () => {
  const seq = (b: number[]) => ({ bytes: (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => b[i % b.length]!)) });
  it("newId 26 base32, newNonce 32 hex, newTopic önek + 26", () => {
    expect(newId(seq([0, 255, 17]))).toMatch(/^[a-z2-7]{26}$/);
    expect(newNonce(seq([1, 2, 254]))).toMatch(/^[0-9a-f]{32}$/);
    expect(newTopic("vlad-q-", seq([9, 8, 7]))).toMatch(/^vlad-q-[a-z2-7]{26}$/);
    expect(newTopic("vlad-r-", seq([9, 8, 7]))).toMatch(/^vlad-r-[a-z2-7]{26}$/);
  });
  it("kaynaktan 128 bit ister ve belirleyicidir; kısa dönen kaynak reddedilir", () => {
    const asked: number[] = [];
    const r = { bytes: (n: number) => { asked.push(n); return Buffer.alloc(n, 7); } };
    expect(newId(r)).toBe(newId(r));
    expect(asked.every((n) => n >= 16)).toBe(true);
    expect(() => newId({ bytes: () => Buffer.alloc(3) })).toThrow();
    expect(() => newNonce({ bytes: () => Buffer.alloc(3) })).toThrow();
  });
  it("gerçek rastgelelik: iki çağrı farklı", () => {
    const r = { bytes: (n: number) => randomBytes(n) };
    expect(newId(r)).not.toBe(newId(r));
  });
});
