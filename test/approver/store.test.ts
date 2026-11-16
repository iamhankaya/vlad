import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../../src/approver/store.js";
import { readSecureFile } from "../../src/mode/secure-fs.js";
import type { AckRecord, PendingRecord, RateState, ResultRecord } from "../../src/approver/types.js";
import { secretHits } from "../support/approver-secrets.js";
import { spawnGuarded } from "../support/spawn-vlad.js";

// approver: store (T20261116-06 U2). Yalnız geçici dizin; gerçek ~/.vlad-secret'a dokunmaz. Saat enjekte edilir.
const posix = process.platform !== "win32";
const NOW = new Date("2026-11-16T12:00:00Z");
const day = 86_400_000;
const ID = "mfrggzdfmztwq2lknnwg23tpoa", CID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const root0 = mkdtempSync(join(tmpdir(), "vlad-store-"));
let root: string, dir: string, now: Date, st: Store;
const clock = () => now;
beforeEach(() => { root = realpathSync(mkdtempSync(join(root0, "t-"))); chmodSync(root, 0o700); dir = join(root, "approver"); now = NOW; st = createStore(dir, { now: clock }); });
afterEach(() => { if (realpathSync(root).startsWith(realpathSync(tmpdir()))) rmSync(root, { recursive: true, force: true }); });

const put = (rel: string, body: string | Buffer, mode = 0o600) => { const p = join(dir, rel); writeFileSync(p, body, { mode }); chmodSync(p, mode); return p; };
const pending = (over: Partial<PendingRecord> = {}): PendingRecord => ({
  v: 1, id: ID, shortId: ID.slice(0, 8), cid: CID, op: "install", argv: ["install"], requestedAt: "2026-11-16T14:20:00+03:00", expiresAt: "2026-11-16T14:25:00+03:00", nonce: "0".repeat(32),
  respTopic: "vlad-r-" + CID, digest: "0".repeat(64), ctx: { home: "/h", kb: "/k", cli: "/c" }, keyGen: "0123456789abcdef", status: "pending", requester: "vlad-07", ...over,
});
const result = (over: Partial<ResultRecord> = {}): ResultRecord => ({ v: 1, id: ID, status: "done", exitCode: 0, stdout: "", stderr: "", finishedAt: NOW.toISOString(), ...over });
const rate = (): RateState => ({ v: 1, decisions: [NOW.toISOString()], consecutiveDenied: 1, lockedUntil: null });
const idN = (n: number) => "b".repeat(24) + String.fromCharCode(97 + Math.floor(n / 26)) + String.fromCharCode(97 + (n % 26));

describe("approver: store kurulum", () => {
  it("dizin ağacı 0700", () => {
    for (const d of ["", "inbox", "claimed", "ack", "claims", "results"]) {
      const p = join(dir, d);
      expect(lstatSync(p).isDirectory(), d).toBe(true);
      if (posix) expect(lstatSync(p).mode & 0o777, d).toBe(0o700);
    }
    expect(st.dir).toBe(dir);
  });
  it.runIf(posix)("approver dizini sembolik bağ ya da geniş izinliyse fırlatır", () => {
    const real = join(root, "real"); mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(root, "lnk"));
    expect(() => createStore(join(root, "lnk"))).toThrow(/sembolik/);
    chmodSync(dir, 0o755);
    expect(() => createStore(dir)).toThrow(/0700/);
  });
  it.runIf(posix)("alt dizin sembolik bağa çevrilirse işlem fırlatır (her işlemde yeniden doğrulanır)", () => {
    rmSync(join(dir, "claims"), { recursive: true }); mkdirSync(join(root, "elsewhere"), { mode: 0o700 }); symlinkSync(join(root, "elsewhere"), join(dir, "claims"));
    expect(() => st.markClaim(ID, "decision")).toThrow(/sembolik/);
    expect(readdirSync(join(root, "elsewhere"))).toEqual([]);
  });
});

describe("approver: kimlik doğrulama (traversal)", () => {
  const bad = ["../x", "../../etc/passwd", "A".repeat(26), "a".repeat(25), "a".repeat(27), "", "a/b", "aaaaaaaaaaaaaaaaaaaaaaaaa.", "a".repeat(25) + "\u0000", "a".repeat(26) + ".json"];
  it("tüm kimlik alan yöntemleri NAME_RE dışında fırlatır", () => {
    for (const b of bad) {
      expect(() => st.claimInbox(b), b).toThrow(/kimlik/);
      expect(() => st.markClaim(b, "decision"), b).toThrow(/kimlik/);
      expect(() => st.hasClaim(b, "exec"), b).toThrow(/kimlik/);
      expect(() => st.readResult(b), b).toThrow(/kimlik/);
      expect(() => st.writeResult(result({ id: b })), b).toThrow(/kimlik/);
      expect(() => st.writeAck({ v: 1, cid: b, status: "pending" }), b).toThrow(/kimlik/);
      expect(() => st.writePending(pending({ id: b })), b).toThrow(/kimlik/);
    }
    expect(readdirSync(root).sort()).toEqual(["approver"]); // dışarıya yazılmadı
  });
});

describe("approver: channel", () => {
  const ch = { v: 1, server: "https://ntfy.sh", requestTopic: "vlad-q-" + CID, createdAt: NOW.toISOString() };
  it("yoksa null; varsa okur", () => { expect(st.readChannel()).toBeNull(); put("channel.json", JSON.stringify(ch)); expect(st.readChannel()).toEqual(ch); });
  it("bozuk/kesik/şekilsiz/yanlış izinli/sembolik bağ fırlatır", () => {
    put("channel.json", JSON.stringify(ch).slice(0, 20)); expect(() => st.readChannel()).toThrow();
    put("channel.json", JSON.stringify({ ...ch, server: 5 })); expect(() => st.readChannel()).toThrow();
    if (!posix) return;
    put("channel.json", JSON.stringify(ch), 0o644); expect(() => st.readChannel()).toThrow(/0600/);
    rmSync(join(dir, "channel.json")); put("real.json", JSON.stringify(ch)); symlinkSync(join(dir, "real.json"), join(dir, "channel.json")); expect(() => st.readChannel()).toThrow();
  });
});

describe("approver: inbox", () => {
  it("listInbox yalnız <cid>.json adlarını verir; .tmp-* ve yabancı adlar sayılmaz/kotaya girmez", () => {
    put(`inbox/${CID}.json`, "{}");
    put("inbox/.tmp-123-abcdef", "x".repeat(10_000)); put("inbox/notes.txt", "x"); put(`inbox/${CID}.json.bak`, "x");
    expect(st.listInbox()).toEqual([CID]);
    expect(existsSync(join(dir, "inbox", ".tmp-123-abcdef"))).toBe(true); // dokunulmadı
  });
  it("20 dosya sınırı: fazlası silinir, oversize loglanır, en eski olanlar kalır", () => {
    for (let i = 0; i < 25; i++) { const p = put(`inbox/${idN(i)}.json`, "{}"); const t = new Date(NOW.getTime() - (100 - i) * 1000); utimesSync(p, t, t); }
    const kept = st.listInbox();
    expect(kept.length).toBe(20);
    expect(kept).toEqual(Array.from({ length: 20 }, (_, i) => idN(i)));
    expect(readdirSync(join(dir, "inbox")).length).toBe(20);
    expect(readFileSync(join(dir, "approver.log"), "utf8")).toContain("oversize");
  });
  it("160 KB toplam bayt sınırı", () => {
    for (let i = 0; i < 4; i++) { const p = put(`inbox/${idN(i)}.json`, "x".repeat(60_000)); const t = new Date(NOW.getTime() - (100 - i) * 1000); utimesSync(p, t, t); }
    expect(st.listInbox()).toEqual([idN(0), idN(1)]); // 120 KB sığar, 180 KB sığmaz
    expect(readdirSync(join(dir, "inbox")).length).toBe(2);
  });
  it("sembolik bağ girdisi listelenmez", () => {
    if (!posix) return;
    put("real.txt", "{}"); symlinkSync(join(dir, "real.txt"), join(dir, "inbox", `${CID}.json`));
    expect(st.listInbox()).toEqual([]);
  });
  it("claimInbox: claimed/'a taşır, içeriği döner; ikinci çağrı ve yok null", () => {
    put(`inbox/${CID}.json`, '{"a":1}');
    expect(st.claimInbox(CID)?.toString()).toBe('{"a":1}');
    expect(existsSync(join(dir, "inbox", `${CID}.json`))).toBe(false);
    expect(existsSync(join(dir, "claimed", `${CID}.json`))).toBe(true);
    expect(st.claimInbox(CID)).toBeNull();
    expect(st.claimInbox("b".repeat(26))).toBeNull();
  });
  it("claimInbox: 8 KB üstü ve yanlış izin fırlatır (sahiplenildikten sonra)", () => {
    put(`inbox/${CID}.json`, "x".repeat(8193)); expect(() => st.claimInbox(CID)).toThrow(/boyut/);
    put(`inbox/${idN(1)}.json`, "x".repeat(8192)); expect(st.claimInbox(idN(1))?.length).toBe(8192);
    if (!posix) return;
    put(`inbox/${idN(2)}.json`, "{}", 0o644); expect(() => st.claimInbox(idN(2))).toThrow(/0600/);
  });
});

describe("approver: ack", () => {
  it("ack/<cid>.json 0600, üzerine yazılabilir", () => {
    const a: AckRecord = { v: 1, cid: CID, status: "pending", id: ID, expiresAt: "x" };
    st.writeAck(a);
    expect(JSON.parse(readFileSync(join(dir, "ack", `${CID}.json`), "utf8"))).toEqual(a);
    if (posix) expect(lstatSync(join(dir, "ack", `${CID}.json`)).mode & 0o777).toBe(0o600);
    st.writeAck({ v: 1, cid: CID, status: "busy" });
    expect(JSON.parse(readFileSync(join(dir, "ack", `${CID}.json`), "utf8")).status).toBe("busy");
  });
});

describe("approver: pending", () => {
  it("yoksa null; yaz/oku/temizle", () => {
    expect(st.readPending()).toBeNull();
    st.writePending(pending()); expect(st.readPending()).toEqual(pending());
    st.writePending(pending({ status: "approved" })); expect(st.readPending()?.status).toBe("approved");
    st.clearPending(); expect(st.readPending()).toBeNull(); st.clearPending();
  });
  it("bozuk/kesik/şekilsiz/yanlış izinli/sembolik bağ: fırlatır (fail-closed), dosyaya dokunmaz", () => {
    const good = JSON.stringify(pending());
    for (const body of [good.slice(0, 30), "", "null", "[]", JSON.stringify({ ...pending(), status: "weird" }), JSON.stringify({ ...pending(), id: "../x" }), JSON.stringify({ ...pending(), argv: "install" })]) {
      put("pending.json", body); expect(() => st.readPending(), body.slice(0, 20)).toThrow();
      expect(readFileSync(join(dir, "pending.json"), "utf8")).toBe(body);
    }
    if (!posix) return;
    put("pending.json", good, 0o644); expect(() => st.readPending()).toThrow(/0600/);
    rmSync(join(dir, "pending.json")); put("p2.json", good); symlinkSync(join(dir, "p2.json"), join(dir, "pending.json")); expect(() => st.readPending()).toThrow();
  });
});

describe("approver: claims", () => {
  it("wx: ilk true, sonrakiler false; karar ve exec ayrı", () => {
    expect(st.hasClaim(ID, "decision")).toBe(false);
    expect(st.markClaim(ID, "decision")).toBe(true);
    expect(st.markClaim(ID, "decision")).toBe(false);
    expect(st.hasClaim(ID, "decision")).toBe(true);
    expect(st.hasClaim(ID, "exec")).toBe(false);
    expect(st.markClaim(ID, "exec")).toBe(true);
    expect(st.markClaim(ID, "exec")).toBe(false);
    expect(readdirSync(join(dir, "claims")).sort()).toEqual([ID, `${ID}.exec`]);
  });
  it.runIf(posix)("önceden yerleştirilmiş sembolik bağ üzerinden yazılmaz (false)", () => {
    put("victim", "x"); symlinkSync(join(dir, "victim"), join(dir, "claims", ID));
    expect(st.markClaim(ID, "decision")).toBe(false);
    expect(readFileSync(join(dir, "victim"), "utf8")).toBe("x");
  });
});

// gerçek eşzamanlılık: ayrı süreçler (dist/ gerekir; test/global-setup.ts derler)
const dist = join(import.meta.dirname, "..", "..", "dist");
const CHILD = (body: string) => `import { pathToFileURL as u } from "node:url"; const [,dir,id,at] = process.argv;
const { createStore } = await import(u(${JSON.stringify(join(dist, "approver", "store.js"))}).href);
const { writeAtomic } = await import(u(${JSON.stringify(join(dist, "mode", "secure-fs.js"))}).href);
const s = createStore(dir); while (Date.now() < Number(at)) { /* ortak başlangıç */ }
${body}`;
const runChildren = (n: number, body: string, args: string[]): Promise<string[]> => {
  const at = String(Date.now() + 1500);
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise<string>((res, rej) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", CHILD(body), dir, ...args, at, String(i)], { stdio: ["ignore", "pipe", "pipe"] });
    let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d));
    c.on("close", (code) => (code === 0 ? res(o.trim()) : rej(new Error(`çocuk ${i} çıkış ${code}: ${e}`))));
  })));
};
describe("approver: eşzamanlılık (gerçek süreçler)", () => {
  it("markClaim: 8 süreç aynı kimliği ister, tam bir tane true alır", async () => {
    const r = await runChildren(8, `console.log(s.markClaim(id, "decision"));`, [ID]);
    expect(r.filter((x) => x === "true").length).toBe(1);
    expect(r.filter((x) => x === "false").length).toBe(7);
  }, 20_000);
  it("claimInbox: 8 süreç aynı isteği sahiplenmeye çalışır, tam biri içeriği alır", async () => {
    put(`inbox/${CID}.json`, '{"k":1}');
    const r = await runChildren(8, `const b = s.claimInbox(id); console.log(b === null ? "null" : b.toString());`, [CID]);
    expect(r.filter((x) => x === '{"k":1}').length).toBe(1);
    expect(r.filter((x) => x === "null").length).toBe(7);
  }, 20_000);
  it("writeAtomic(overwrite:false) yarışı: tam bir yazar kazanır; okuyucu hiçbir zaman kesik/bozuk içerik görmez", async () => {
    const target = join(dir, "results", `${ID}.json`);
    const racers = runChildren(6, `try { writeAtomic(dir + "/results/" + id + ".json", JSON.stringify({ who: process.argv[4], pad: "x".repeat(4000) }), { overwrite: false }); console.log("won"); } catch (e) { console.log(e.code === "EEXIST" ? "lost" : "err:" + e.message); }`, [ID]);
    const seen = new Set<string>(); let stop = false;
    const reader = (async () => {
      while (!stop) {
        try { const o = JSON.parse(readSecureFile(target, 10_000).toString("utf8")); seen.add(String(o.who)); expect(o.pad.length).toBe(4000); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    const r = await racers; stop = true; await reader;
    expect(r.filter((x) => x === "won").length).toBe(1);
    expect(r.filter((x) => x === "lost").length).toBe(5);
    expect(seen.size).toBe(1);
    expect(readdirSync(join(dir, "results")).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
  }, 30_000);
});

describe("approver: results", () => {
  it("yaz/oku; üzerine yazma yok; yoksa null", () => {
    expect(st.readResult(ID)).toBeNull();
    st.writeResult(result({ stdout: "çıktı" })); expect(st.readResult(ID)).toEqual(result({ stdout: "çıktı" }));
    expect(() => st.writeResult(result({ status: "failed" }))).toThrow();
    expect(st.readResult(ID)?.status).toBe("done");
  });
  it("bozuk sonuç dosyası readResult'ta fırlatır", () => {
    put(`results/${ID}.json`, '{"v":1,"id":'); expect(() => st.readResult(ID)).toThrow();
    put(`results/${ID}.json`, JSON.stringify({ v: 1, id: ID, status: "nope" })); expect(() => st.readResult(ID)).toThrow();
  });
  it("listResults: yeniden eskiye, limit; bozuk dosyayı atlar ve loglar", () => {
    for (let i = 0; i < 5; i++) st.writeResult(result({ id: idN(i), finishedAt: new Date(NOW.getTime() - (10 - i) * 1000).toISOString() }));
    put(`results/${idN(9)}.json`, "{bozuk");
    const all = st.listResults();
    expect(all.map((r) => r.id)).toEqual([idN(4), idN(3), idN(2), idN(1), idN(0)]);
    expect(st.listResults(2).map((r) => r.id)).toEqual([idN(4), idN(3)]);
    expect(readFileSync(join(dir, "approver.log"), "utf8")).toContain("results");
  });
  it("7 günden eski sonuçlar budanır (enjekte saat); 7 gün tam sınırda kalır", () => {
    st.writeResult(result({ id: idN(1), finishedAt: new Date(NOW.getTime() - 8 * day).toISOString() }));
    st.writeResult(result({ id: idN(2), finishedAt: new Date(NOW.getTime() - 7 * day).toISOString() }));
    st.writeResult(result({ id: idN(3), finishedAt: new Date(NOW.getTime() - 1 * day).toISOString() }));
    expect(st.listResults().map((r) => r.id).sort()).toEqual([idN(2), idN(3)]);
    expect(existsSync(join(dir, "results", `${idN(1)}.json`))).toBe(false);
    now = new Date(NOW.getTime() + 7 * day);
    st.writeResult(result({ id: idN(4), finishedAt: now.toISOString() }));
    expect(readdirSync(join(dir, "results"))).toEqual([`${idN(4)}.json`]); // idN(2) 14 gün, idN(3) 8 gün old: ikisi de budanır
  });
});

describe("approver: rate", () => {
  it("yoksa varsayılan; yaz/oku", () => {
    expect(st.readRate()).toEqual({ v: 1, decisions: [], consecutiveDenied: 0, lockedUntil: null });
    st.writeRate(rate()); expect(st.readRate()).toEqual(rate());
    st.writeRate({ ...rate(), lockedUntil: "2026-11-16T13:00:00Z" }); expect(st.readRate().lockedUntil).toBe("2026-11-16T13:00:00Z");
  });
  it("bozuk/kesik/şekilsiz/yanlış izin/sembolik bağ: fırlatır, dosya sıfırlanmaz", () => {
    const good = JSON.stringify(rate());
    for (const body of [good.slice(0, 15), "", "null", JSON.stringify({ ...rate(), decisions: "x" }), JSON.stringify({ ...rate(), consecutiveDenied: -1 }), JSON.stringify({ ...rate(), lockedUntil: 5 }), JSON.stringify({ ...rate(), v: 2 })]) {
      put("rate.json", body); expect(() => st.readRate(), body.slice(0, 20)).toThrow();
      expect(readFileSync(join(dir, "rate.json"), "utf8")).toBe(body);
    }
    if (!posix) return;
    put("rate.json", good, 0o644); expect(() => st.readRate()).toThrow(/0600/);
    rmSync(join(dir, "rate.json")); put("r2.json", good); symlinkSync(join(dir, "r2.json"), join(dir, "rate.json")); expect(() => st.readRate()).toThrow();
  });
});

describe("approver: log", () => {
  const logPath = () => join(dir, "approver.log");
  it("zaman damgalı satır ekler; satır sonu/kontrol karakteri tek satıra indirilir; sır kalıpları gizlenir", () => {
    st.log("ilk"); st.log("iki\nsahte satır\u0000x");
    st.log(`anahtar ${"ab".repeat(32)} VMT2.1.aa.bb.cc VLAD_MODE_TOKEN=abc`);
    const text = readFileSync(logPath(), "utf8"), lines = text.trim().split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe(`${NOW.toISOString()} ilk`);
    expect(secretHits(text)).toEqual([]);
    if (posix) expect(lstatSync(logPath()).mode & 0o777).toBe(0o600);
  });
  it("tek satır 1 KB ile sınırlıdır", () => { st.log("x".repeat(5000)); expect(readFileSync(logPath(), "utf8").length).toBeLessThan(1200); });
  it("256 KB'de .1'e döner; yeni log küçük başlar; eski .1 ezilir", () => {
    const line = "y".repeat(900);
    for (let i = 0; i < 300; i++) st.log(line);
    expect(existsSync(`${logPath()}.1`)).toBe(true);
    expect(lstatSync(logPath()).size).toBeLessThan(262_144);
    expect(lstatSync(`${logPath()}.1`).size).toBeLessThanOrEqual(262_144 + 1100);
    expect(lstatSync(`${logPath()}.1`).size).toBeGreaterThan(200_000);
    for (let i = 0; i < 600; i++) st.log(line);
    expect(readdirSync(dir).filter((f) => f.startsWith("approver.log")).sort()).toEqual(["approver.log", "approver.log.1"]);
  });
  it("yazılamazsa fırlatmaz (servisi çökertmez)", () => {
    if (!posix) return;
    rmSync(logPath(), { force: true }); mkdirSync(logPath());
    expect(() => st.log("x")).not.toThrow();
  });
});

describe("approver: service.lock", () => {
  const lock = () => join(dir, "service.lock");
  it("alır; canlı pid varken ikinci istek busy; release sonrası yeniden alınır", () => {
    expect(st.acquireLock(process.pid, now)).toBe("acquired");
    expect(JSON.parse(readFileSync(lock(), "utf8"))).toEqual({ pid: process.pid, startedAt: NOW.toISOString() });
    expect(st.acquireLock(process.pid, now)).toBe("busy");
    expect(createStore(dir, { now: clock }).acquireLock(process.pid, now)).toBe("busy");
    st.releaseLock(); expect(existsSync(lock())).toBe(false);
    expect(st.acquireLock(process.pid, now)).toBe("acquired");
    st.releaseLock(); st.releaseLock();
  });
  it("ölü pid devralınır", () => {
    const dead = spawnGuarded(process.execPath, ["-e", ""]).pid!;
    put("service.lock", JSON.stringify({ pid: dead, startedAt: "2026-11-15T00:00:00Z" }));
    expect(st.acquireLock(process.pid, now)).toBe("acquired");
    expect(JSON.parse(readFileSync(lock(), "utf8")).pid).toBe(process.pid);
  });
  it("başkasının kilidini releaseLock silmez", () => {
    put("service.lock", JSON.stringify({ pid: process.pid + 1, startedAt: "x" }));
    st.releaseLock(); expect(existsSync(lock())).toBe(true);
  });
  it("bozuk kilit dosyası fırlatır (fail-closed)", () => {
    put("service.lock", "{bozuk"); expect(() => st.acquireLock(process.pid, now)).toThrow();
    put("service.lock", JSON.stringify({ pid: "x" })); expect(() => st.acquireLock(process.pid, now)).toThrow();
  });
  it("iki süreç yarışı: canlı çocuklar arasında tam biri alır", async () => {
    const r = await runChildren(6, `const r = s.acquireLock(process.pid, new Date()); while (Date.now() < Number(at) + 700) { /* kilit sahibi canlı kalsın */ } console.log(r);`, [ID]);
    expect(r.filter((x) => x === "acquired").length).toBe(1);
    expect(r.filter((x) => x === "busy").length).toBe(5);
  }, 20_000);
  it("bayat kilit yarışı: 8 süreç ölü pid kilidini devralmak ister, en çok biri alır; stale artığı kalmaz", async () => {
    const dead = spawnGuarded(process.execPath, ["-e", ""]).pid!;
    await new Promise((r) => setTimeout(r, 200));
    put("service.lock", JSON.stringify({ pid: dead, startedAt: "2026-11-15T00:00:00Z" }));
    const r = await runChildren(8, `const r = s.acquireLock(process.pid, new Date()); while (Date.now() < Number(at) + 700) { /* sahip canlı kalsın */ } console.log(r);`, [ID]);
    expect(r.filter((x) => x === "acquired").length).toBe(1);
    expect(r.filter((x) => x === "busy").length).toBe(7);
    expect(readdirSync(dir).filter((f) => f.includes(".stale."))).toEqual([]);
  }, 20_000);
  it("bayat kilit tek süreçte: devralınca stale artığı bırakılmaz", () => {
    const dead = spawnGuarded(process.execPath, ["-e", ""]).pid!;
    put("service.lock", JSON.stringify({ pid: dead, startedAt: "2026-11-15T00:00:00Z" }));
    expect(st.acquireLock(process.pid, now)).toBe("acquired");
    expect(readdirSync(dir).filter((f) => f.includes(".stale."))).toEqual([]);
  });
});
