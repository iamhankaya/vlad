// F-245 kabulü (T20261105-62; plan "F-245 arayüzü"): ~/.claude.json kilidi `<file>.vlad-lock/owner.json {pid, nonce, startedAt}`.
// Kırma yalnız (a) owner var ve pid yaşamıyor, ya da (b) owner yok/okunamıyor ve dizin mtime'ı 15 sn'yi geçmiş; yaşayan pid hiç kırılmaz.
// `TrustOpts.isAlive(pid)` ve `now()` test enjeksiyonudur. Gerçek ~/.claude.json'a dokunulmaz: dosya her testte geçici dizinde.
// U4b'ye kadar KIRMIZI: bugünkü kod yalnız mtime'a bakar (ölü sahip kırılmaz, yaşayan ama yavaş sahip kırılır).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trustWorktree } from "../../src/tasks/trust.js";
import { rmTemp } from "../helpers.js";

let dir: string, file: string, lock: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-u4f245-")));
  file = join(dir, "claude.json");
  lock = `${file}.vlad-lock`;
});
afterEach(() => rmTemp(dir));

type Opts = { lockWaitMs?: number; isAlive?: (pid: number) => boolean; now?: () => number };
const trust = (o: Opts) => trustWorktree("/tmp/u4-wt/T1", file, o as never);
const makeLock = (owner: object | null, ageMs: number) => {
  mkdirSync(lock);
  if (owner) writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
  const t = new Date(Date.now() - ageMs);
  utimesSync(lock, t, t);
};
const trusted = () => existsSync(file) && JSON.parse(readFileSync(file, "utf8")).projects?.["/tmp/u4-wt/T1"]?.hasTrustDialogAccepted === true;

describe("F-245 kilit protokolü", () => {
  it("sahibi ölü kilit (owner.json var, pid yaşamıyor) kırılır, kayıt yazılır, kilit kalmaz", () => {
    makeLock({ pid: 4242, nonce: "n1", startedAt: Date.now() }, 0); // taze mtime: yalnız pid ölümü kırar
    expect(trust({ lockWaitMs: 500, isAlive: () => false })).toBeNull();
    expect(trusted()).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
  it("yaşayan sahip startedAt sınırı (2 dk) dolmadan kırılmaz: eski mtime olsa bile bekler, deadline'da uyarıyla vazgeçer, dosyaya dokunmaz", () => {
    makeLock({ pid: 4242, nonce: "n1", startedAt: Date.now() - 60_000 }, 3_600_000);
    const r = trust({ lockWaitMs: 150, isAlive: () => true });
    expect(typeof r).toBe("string");
    expect(r).toMatch(/kilitli/);
    expect(trusted()).toBe(false);
    expect(existsSync(lock)).toBe(true); // başkasının kilidi silinmedi
  });
  it("owner.json yok + dizin taze (mkdir ile yazım arası) ⇒ kırılmaz", () => {
    makeLock(null, 1_000);
    const r = trust({ lockWaitMs: 150, isAlive: () => false });
    expect(typeof r).toBe("string");
    expect(trusted()).toBe(false);
  });
  it("owner.json yok + dizin mtime 15 sn'yi geçmiş ⇒ kırılır", () => {
    makeLock(null, 20_000);
    expect(trust({ lockWaitMs: 500, isAlive: () => false })).toBeNull();
    expect(trusted()).toBe(true);
  });
  it("owner.json okunamıyor (bozuk JSON) + eski ⇒ kırılır; bozuk + taze ⇒ kırılmaz", () => {
    mkdirSync(lock); writeFileSync(join(lock, "owner.json"), "{bozuk");
    const t = new Date(Date.now() - 20_000); utimesSync(lock, t, t);
    expect(trust({ lockWaitMs: 500, isAlive: () => true })).toBeNull();
    expect(trusted()).toBe(true);
    rmTemp(file); // yeni senaryo
    mkdirSync(lock); writeFileSync(join(lock, "owner.json"), "{bozuk");
    expect(typeof trust({ lockWaitMs: 150, isAlive: () => true })).toBe("string");
  });
  it("enjekte saat: now() ileri sarılınca (mtime sınırı geçti) sahipsiz kilit kırılır", () => {
    makeLock(null, 0);
    const base = Date.now();
    expect(trust({ lockWaitMs: 500, isAlive: () => false, now: () => base + 16_000 })).toBeNull();
    expect(trusted()).toBe(true);
  });
  it("kırma atomik rename'dir: kırıldıktan sonra *.stale-* artığı kalmaz", () => {
    makeLock({ pid: 4242, nonce: "n1", startedAt: Date.now() }, 0);
    expect(trust({ lockWaitMs: 500, isAlive: () => false })).toBeNull();
    expect(readdirSync(dir).filter((f) => f.includes(".stale-"))).toEqual([]);
  });
  it("normal edinme/bırakma: kilit dizini bırakılır, sahip yokken tekrar çağrı çalışır", () => {
    expect(trust({ isAlive: () => true })).toBeNull();
    expect(existsSync(lock)).toBe(false);
    expect(trust({ isAlive: () => true })).toBeNull();
  });
});
