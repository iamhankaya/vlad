import { chmodSync, lstatSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeReset, disableKey, initKey, keyState, mintToken, requireModeAuthority, secretDir, setSecretDirForTests, verifyToken } from "../../src/mode/token.js";
import { modeLine, modeStatus, setNight } from "../../src/mode/store.js";
import { kbPaths } from "../../src/kb/index.js";
import { buildPosixScript, envWithoutModeToken } from "../../src/launcher/posix.js";
import { buildScript } from "../../src/launcher/terminal.js";
import { checkWorkerMode } from "../../src/hooks/mode-guard.js";
import { makeHome } from "../helpers.js";
import { runCli } from "../support/run-cli.js";

// F-vlad-287 (T20261113-18): imzalı mod belirteci. Gizli dizin geçici; gerçek ~/.vlad-secret'a dokunulmaz.
let home: string, sdir: string;
const cwd0 = process.cwd();
const now = new Date("2026-11-13T10:00:00+03:00");
const H = 3_600_000;
beforeEach(() => {
  home = makeHome(); process.chdir(home);
  sdir = join(mkdtempSync(join(tmpdir(), "vlad-secret-")), "s"); // henüz yok = mekanizma etkin değil
  setSecretDirForTests(sdir);
});
afterEach(() => { process.chdir(cwd0); vi.unstubAllEnvs(); setSecretDirForTests(null); rmSync(join(sdir, ".."), { recursive: true, force: true }); });
const modeFile = () => join(kbPaths().kb, "mode.json");

describe("anahtar ve belirteç", () => {
  it("gizli dizin yokken mekanizma kapalı: korunan işlem belirteçsiz geçer (kurulmamış makine)", () => {
    expect(() => requireModeAuthority({}, now)).not.toThrow();
  });
  it("initKey dizini 0700, anahtarı 0600 yazar, ikinci çağrı üzerine yazmaz", () => {
    expect(initKey()).toBe(true);
    const key = readFileSync(join(secretDir(), "mode.key"), "utf8");
    expect(key.trim()).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect(statSync(secretDir()).mode & 0o777).toBe(0o700);
      expect(statSync(join(secretDir(), "mode.key")).mode & 0o777).toBe(0o600);
    }
    expect(initKey()).toBe(false);
    expect(readFileSync(join(secretDir(), "mode.key"), "utf8")).toBe(key);
  });
  it("etkinken belirteçsiz/geçersiz/süresi dolmuş/başka anahtarlı belirteç reddedilir, geçerli geçer", () => {
    initKey();
    expect(() => requireModeAuthority({}, now)).toThrow(/VLAD_MODE_TOKEN/);
    const t = mintToken(H, now);
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: t }, now)).not.toThrow();
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: t }, new Date(now.getTime() + 2 * H))).toThrow(/süre/);
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: t.slice(0, -2) + "00" }, now)).toThrow(/geçersiz/);
    const [v, exp, sig] = t.split(".");
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: `${v}.${Number(exp) + 99 * H}.${sig}` }, now)).toThrow(/geçersiz/); // süreyi uzatma
    expect(verifyToken("çöp", now)).toBe(false);
    rmSync(join(sdir, "mode.key"));
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: t }, now)).toThrow(/anahtar/); // dizin var, anahtar yok = fail-closed
  });
  it("ttl tavanı 72 saat", () => {
    initKey();
    expect(() => mintToken(73 * H, now)).toThrow(/72/);
  });
});

describe("imzalı gece penceresi: mode.json'u doğrudan yazmak yetki vermez", () => {
  it("anahtar yokken eski davranış: imzasız pencere geçerli", () => {
    setNight({ until: "23:59", push: true }, now);
    expect(modeStatus(now).night?.push).toBe(true);
  });
  it("anahtar varken setNight imzalar; elle yazılan/değiştirilen pencere sayılmaz (forged)", () => {
    initKey();
    setNight({ until: "13:00", push: false }, now);
    expect(modeStatus(now).night).not.toBeNull();
    const raw = JSON.parse(readFileSync(modeFile(), "utf8"));
    expect(raw.night.sig).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(modeFile(), JSON.stringify({ ...raw, night: { ...raw.night, push: true } })); // çalışan push yetkisi ekler
    const s = modeStatus(now);
    expect(s.night).toBeNull();
    expect((s as { forged?: boolean }).forged).toBe(true);
    const { sig: _s, ...unsigned } = raw.night;
    writeFileSync(modeFile(), JSON.stringify({ night: unsigned, watch: false })); // imzasız sıfırdan pencere
    expect(modeStatus(now).night).toBeNull();
  });
  it("imzalı pencere watch/expire yazımlarından sonra da geçerli kalır", async () => {
    initKey();
    setNight({ until: "13:00" }, now);
    const { setWatch } = await import("../../src/mode/store.js");
    setWatch(true, now);
    expect(modeStatus(now).night).not.toBeNull();
  });
});

describe("CLI: hook'u atlatsa da belirteçsiz korunan işlem reddedilir", () => {
  const vlad = (args: string[], env: Record<string, string> = {}) => runCli(args, { env: { VLAD_HOME: home, ...env } });
  it("mode night/watch/off belirteçsiz reddedilir, belirteçle çalışır; status serbest", async () => {
    initKey();
    for (const a of [["mode", "night", "--until", "23:59"], ["mode", "watch", "on"], ["mode", "off"]]) {
      const r = await vlad(a);
      expect(r.code, a.join(" ")).not.toBe(0);
      expect(r.err + r.out).toMatch(/VLAD_MODE_TOKEN/);
    }
    expect(existsSync(modeFile())).toBe(false);
    expect((await vlad(["mode", "status"])).code).toBe(0);
    const tok = mintToken(H, new Date());
    expect((await vlad(["mode", "night", "--until", "23:59"], { VLAD_MODE_TOKEN: tok })).code).toBe(0);
    expect((await vlad(["mode", "off"], { VLAD_MODE_TOKEN: tok })).code).toBe(0);
  });
  it("Codex kaçışları: VLAD_TASK_ID'siz, worktree dışı cd ile bile (env -u eşdeğeri) belirteçsiz mode night reddedilir", async () => {
    initKey();
    const r = await vlad(["mode", "night", "--until", "23:59", "--push"], { VLAD_TASK_ID: "" });
    expect(r.code).not.toBe(0);
    expect(existsSync(modeFile())).toBe(false);
  });
  it("setup (--check hariç) belirteçsiz reddedilir", async () => {
    initKey();
    const r = await vlad(["setup", "--only", "permissions"]);
    expect(r.err + r.out).toMatch(/VLAD_MODE_TOKEN/);
  });
  it("mode token TTY'siz (çalışanın borulu Bash'i) reddedilir ve anahtar üretmez", async () => {
    const r = await vlad(["mode", "token"]);
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toMatch(/TTY|terminal/i);
    expect(existsSync(join(sdir, "mode.key"))).toBe(false);
  });
});

describe("incelemede çıkan kaçışlar", () => {
  const vlad = (args: string[], env: Record<string, string> = {}) => runCli(args, { env: { VLAD_HOME: home, ...env } });
  it("VLAD_SECRET_DIR / HOME ortamıyla gizli dizin değiştirilemez: mekanizma kapanmaz", async () => {
    initKey();
    const r = await vlad(["mode", "night", "--until", "23:59", "--push"], { VLAD_SECRET_DIR: join(sdir, "yok"), HOME: join(sdir, "yok2") });
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toMatch(/VLAD_MODE_TOKEN/);
    expect(existsSync(modeFile())).toBe(false);
  });
  it("imzalı pencere varken gizli dizin silinirse pencere yetki sayılmaz (fail-closed)", () => {
    initKey();
    setNight({ until: "13:00" }, now);
    expect(modeStatus(now).night).not.toBeNull();
    rmSync(sdir, { recursive: true, force: true });
    const s = modeStatus(now);
    expect(s.night).toBeNull();
    expect(s.forged).toBe(true);
  });
  it("bozuk anahtar mode token --reset ile kurtarılır (initKey(true)); eski belirteç geçersiz olur", () => {
    initKey();
    const old = mintToken(H, now);
    writeFileSync(join(sdir, "mode.key"), "bozuk\n");
    expect(() => requireModeAuthority({}, now)).toThrow(/bozuk/);
    expect(initKey()).toBe(false);
    expect(initKey(true)).toBe(true);
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: old }, now)).toThrow(/geçersiz/);
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: mintToken(H, now) }, now)).not.toThrow();
  });
  it("tmux/alt süreç ortamı belirteçsizdir", () => {
    expect(envWithoutModeToken({ VLAD_MODE_TOKEN: "x", PATH: "p" })).toEqual({ PATH: "p" });
  });
  it("hook: `mode.key` geçen salt grep/commit mesajı yanlış pozitif vermez", () => {
    expect(checkWorkerMode("Bash", { command: "grep -rn mode.key src" }, "/kb", { cwd: "/work" })).toBeNull();
  });
});

describe("2. tur (VLAD değişiklik turu): fail-closed sertleştirme", () => {
  const posix = process.platform !== "win32";
  it.runIf(posix)("1. gizli dizin okunamıyorsa (EACCES) mekanizma kapalı sayılmaz: fail-closed", () => {
    initKey();
    const parent = join(sdir, "..");
    chmodSync(parent, 0o000);
    try { expect(() => requireModeAuthority({}, now)).toThrow(/gizli dizin|fail-closed/); } finally { chmodSync(parent, 0o700); }
  });
  it.runIf(posix)("1. gizli dizin sembolik bağsa fail-closed (yönlendirme)", () => {
    const real = join(sdir, "..", "gercek"); mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, sdir);
    expect(() => requireModeAuthority({}, now)).toThrow(/sembolik|fail-closed/);
  });
  it.runIf(posix)("4. dizin ya da anahtar grup/diğer okunabilirse fail-closed (tercih: ret, uyarı değil)", () => {
    initKey();
    chmodSync(join(sdir, "mode.key"), 0o644);
    expect(() => requireModeAuthority({}, now)).toThrow(/izin|0600/);
    chmodSync(join(sdir, "mode.key"), 0o600);
    expect(() => requireModeAuthority({}, now)).not.toThrow(/izin/);
    chmodSync(sdir, 0o755);
    expect(() => requireModeAuthority({}, now)).toThrow(/izin|0700/);
  });
  it("2. --reset: geçerli anahtar varken geçerli belirteç şart; belirteçsiz/geçersiz reddedilir", async () => {
    initKey();
    const ask = async () => { throw new Error("sorulmamalı"); };
    await expect(authorizeReset({}, now, ask)).rejects.toThrow(/VLAD_MODE_TOKEN/);
    await expect(authorizeReset({ VLAD_MODE_TOKEN: "VMT1.1.00" }, now, ask)).rejects.toThrow(/VLAD_MODE_TOKEN/);
    await expect(authorizeReset({ VLAD_MODE_TOKEN: mintToken(H, now) }, now, ask)).resolves.toBeUndefined();
  });
  it("2. --reset: anahtar bozukken yalnız elle yazılan SIFIRLA onayı kabul edilir (belirteç yetmez/istenmez)", async () => {
    initKey();
    writeFileSync(join(sdir, "mode.key"), "bozuk\n");
    await expect(authorizeReset({}, now, async () => "evet")).rejects.toThrow(/SIFIRLA/);
    await expect(authorizeReset({}, now, async () => "sifirla")).rejects.toThrow(/SIFIRLA/);
    await expect(authorizeReset({}, now, async () => "SIFIRLA")).resolves.toBeUndefined();
  });
  it.runIf(posix)("2. --reset: izinleri geniş (okunamaz sayılan) anahtar da SIFIRLA ister", async () => {
    initKey();
    const tok = mintToken(H, now); // anahtar bozulmadan önce üretilmiş geçerli belirteç bile yetmez: doğrulanamaz
    chmodSync(join(sdir, "mode.key"), 0o644);
    await expect(authorizeReset({ VLAD_MODE_TOKEN: tok }, now, async () => "")).rejects.toThrow(/SIFIRLA/);
  });
  it("2. --reset: gizli dizin hiç yoksa sıfırlama gerekmez (ilk kurulum, belirteç/onay istenmez)", async () => {
    await expect(authorizeReset({}, now, async () => { throw new Error("sorulmamalı"); })).resolves.toBeUndefined();
  });
  it("2. CLI: mode token --reset TTY'siz yine reddedilir (belirteç şartı ek katman)", async () => {
    initKey();
    const r = await runCli(["mode", "token", "--reset"], { env: { VLAD_HOME: home } });
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(sdir, "mode.key"), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("çalışan başlatma betikleri belirteci temizler", () => {
  const req = { taskId: "T20261113-18", cwd: "/x/wt/T20261113-18", title: "t", prompt: "p", env: { VLAD_TASK_ID: "T20261113-18" } };
  it("POSIX betiği: export'lardan önce unset VLAD_MODE_TOKEN", () => {
    const s = buildPosixScript(req as never);
    expect(s.indexOf("unset VLAD_MODE_TOKEN")).toBeGreaterThan(-1);
    expect(s.indexOf("unset VLAD_MODE_TOKEN")).toBeLessThan(s.indexOf("export VLAD_TASK_ID"));
  });
  it("PowerShell betiği: Remove-Item Env:VLAD_MODE_TOKEN", () => {
    expect(buildScript(req as never)).toMatch(/Remove-Item Env:VLAD_MODE_TOKEN/);
  });
});

describe("hook (en iyi çaba): gizli dizin yolu korunur", () => {
  it("anahtar dosyasına dokunan Bash komutu okuma bağlamında bile reddedilir", () => {
    for (const c of ["cat ~/.vlad-secret/mode.key", "cp ~/.vlad-secret/mode.key /tmp/x", "head -c 64 /Users/x/.vlad-secret/mode.key"])
      expect(checkWorkerMode("Bash", { command: c }, "/kb", { cwd: "/work" }), c).toMatch(/anahtar|koruma/);
    expect(checkWorkerMode("Write", { file_path: "/Users/x/.vlad-secret/mode.key" }, "/kb", { cwd: "/work" })).toMatch(/anahtar|koruma/);
    expect(checkWorkerMode("Bash", { command: "ls /work" }, "/kb", { cwd: "/work" })).toBeNull();
  });
});

// F-vlad-336: düşürme (gizli dizin sil + mode.json'dan sig çıkar) tespit edilir; etkinleştirme işareti anahtar dizininin DIŞINDA
describe("düşürme tespiti: etkinleştirme işareti anahtar dizini dışında", () => {
  const marker = () => `${sdir}.active`;
  const night = () => setNight({ until: "2026-11-13T23:00:00+03:00" }, now);
  it("initKey işareti anahtar dizininin dışına yazar; keyState off → ok", () => {
    expect(keyState()).toBe("off");
    initKey();
    expect(existsSync(marker())).toBe(true);
    expect(existsSync(join(sdir, ".active"))).toBe(false);
    expect(keyState()).toBe("ok");
  });
  it("saldırı: gizli dizin silinir + mode.json'dan sig çıkarılır → imzasız moda DÜŞMEZ (pencere yetki değil, korunan işlem fail-closed)", () => {
    initKey();
    night();
    const f = modeFile();
    const j = JSON.parse(readFileSync(f, "utf8"));
    delete j.night.sig;
    rmSync(sdir, { recursive: true, force: true });
    writeFileSync(f, JSON.stringify(j));
    expect(keyState()).toBe("dropped");
    expect(() => requireModeAuthority({}, now)).toThrow(/düşürül/);
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: "VMT1.99999999999999.00" }, now)).toThrow(/düşürül/);
    expect(modeStatus(now).night).toBeNull();
    expect(modeStatus(now).forged).toBe(true);
    expect(modeLine(now)).toMatch(/düşürülmüş|korumasız/);
  });
  it("dropped durumda modeLine (vlad status) uyarır; kapalı/sağlıklı makinede uyarı yok", () => {
    expect(modeLine(now)).toBeNull();
    initKey();
    expect(modeLine(now)).toBeNull();
    rmSync(sdir, { recursive: true, force: true });
    expect(modeLine(now)).toMatch(/UYARI.*düşürülmüş/);
  });
  it("dropped durumda initKey (sıfırlamasız) sessizce yeniden üretmez; --reset üretir ve işareti geri yazar", () => {
    initKey();
    rmSync(sdir, { recursive: true, force: true });
    expect(() => initKey()).toThrow(/düşürül/);
    expect(existsSync(sdir)).toBe(false);
    expect(initKey(true)).toBe(true);
    expect(keyState()).toBe("ok");
  });
  it("meşru tamamen kapatma: geçerli belirteç şart; kapatınca dizin + işaret silinir, korunan işlemler yeniden belirteçsiz çalışır", async () => {
    initKey();
    await expect(authorizeReset({}, now, async () => "SIFIRLA")).rejects.toThrow(/VLAD_MODE_TOKEN/);
    await authorizeReset({ VLAD_MODE_TOKEN: mintToken(H, now) }, now, async () => "");
    disableKey();
    expect(existsSync(sdir)).toBe(false);
    expect(existsSync(marker())).toBe(false);
    expect(keyState()).toBe("off");
    expect(() => requireModeAuthority({}, now)).not.toThrow();
  });
  it("meşru kapatma düşürülmüş makinede: yalnız elle SIFIRLA onayı; sonra işaret de temizlenir", async () => {
    initKey();
    rmSync(sdir, { recursive: true, force: true });
    await expect(authorizeReset({}, now, async () => "evet")).rejects.toThrow(/SIFIRLA/);
    await authorizeReset({}, now, async () => "SIFIRLA");
    disableKey();
    expect(existsSync(marker())).toBe(false);
    expect(() => requireModeAuthority({}, now)).not.toThrow();
  });
  it("sadece işareti silmek gizli dizin varken korumayı kapatmaz (anahtar hâlâ zorunlu kılar)", () => {
    initKey();
    rmSync(marker(), { force: true });
    expect(keyState()).toBe("ok");
    expect(() => requireModeAuthority({}, now)).toThrow(/VLAD_MODE_TOKEN/);
  });
  it("CLI: mode token --disable TTY'siz reddedilir ve hiçbir şeyi silmez", async () => {
    initKey();
    const r = await runCli(["mode", "token", "--disable"], { env: { VLAD_HOME: home } });
    expect(r.code).not.toBe(0);
    expect(existsSync(join(sdir, "mode.key"))).toBe(true);
    expect(existsSync(marker())).toBe(true);
  });
});

// Kapı incelemesi düzeltme turu
describe("düzeltme turu: initKey/işaret sertleştirme", () => {
  const marker = () => `${sdir}.active`;
  it("dizin var + mode.key yok iken sıfırlamasız initKey yeni anahtar üretmez (fırlatır), --reset üretir", () => {
    initKey();
    rmSync(join(sdir, "mode.key"));
    expect(() => initKey()).toThrow(/--reset/);
    expect(existsSync(join(sdir, "mode.key"))).toBe(false);
    expect(initKey(true)).toBe(true);
  });
  it("işaret sembolik bağsa initKey bağı izleyip hedefe yazmaz; geçersiz işaret net hatayla fail-closed", () => {
    const target = join(sdir, "..", "hedef.txt");
    writeFileSync(target, "dokunma");
    symlinkSync(target, marker());
    expect(() => initKey()).toThrow(/işaret/);
    expect(readFileSync(target, "utf8")).toBe("dokunma");
    expect(() => requireModeAuthority({}, now)).toThrow(/işaret/);
    expect(keyState()).toBe("broken");
    // --reset geçersiz işareti bağı izlemeden kaldırıp yeniden yazar
    expect(initKey(true)).toBe(true);
    expect(lstatSync(marker()).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("dokunma");
  });
  it("işaret içeriği VLAD-MODE-ACTIVE1 değilse (boş/rastgele) dizin yokken fail-closed 'geçersiz işaret'", () => {
    writeFileSync(marker(), "");
    expect(() => requireModeAuthority({}, now)).toThrow(/işaret.*geçersiz|geçersiz.*işaret/);
    writeFileSync(marker(), "VLAD-MODE-ACTIVE1\n");
    expect(() => requireModeAuthority({}, now)).toThrow(/düşürül/);
  });
});

describe("düzeltme turu: task close --skip-machine çalışana kapalı", () => {
  const close = (env: Record<string, string>) => runCli(["task", "close", "T20261113-99", "--yes", "--skip-machine", "win", "--reason", "onay"], { env: { VLAD_HOME: home, ...env } });
  it("VLAD_TASK_ID'li çalışan bağlamında reddedilir; çalışan değilse bayrak kabul edilir (görev bulunamaz hatası)", async () => {
    const w = await close({ VLAD_TASK_ID: "T20261113-77" });
    expect(w.code).not.toBe(0);
    expect(`${w.out}${w.err}`).toMatch(/çalışan/);
    const u = await close({ VLAD_TASK_ID: "" });
    expect(`${u.out}${u.err}`).not.toMatch(/çalışan oturumu/);
  });
});

describe("K2: bozuk işaret + sağlam anahtar kilitlenme yapmaz", () => {
  const marker = () => `${sdir}.active`;
  it("bozuk/symlink işaret + sağlam anahtar + süresi dolmuş belirteç: 'broken'; --reset ve --disable yalnız SIFIRLA ile kurtarır", async () => {
    initKey();
    const old = mintToken(H, now);
    const later = new Date(now.getTime() + 2 * H);
    writeFileSync(marker() + ".x", "dokunma");
    rmSync(marker(), { force: true });
    symlinkSync(marker() + ".x", marker());
    expect(keyState()).toBe("broken");
    expect(() => requireModeAuthority({ VLAD_MODE_TOKEN: old }, now)).toThrow(/işaret/); // sağlam belirteç bile geçmez (fail-closed)
    expect(() => mintToken(H, now)).toThrow(/işaret/);
    // belirteç süresi dolmuş: normal yol kilitli, kurtarma SIFIRLA ile
    await expect(authorizeReset({ VLAD_MODE_TOKEN: old }, later, async () => "evet")).rejects.toThrow(/SIFIRLA/);
    await expect(authorizeReset({ VLAD_MODE_TOKEN: old }, later, async () => "SIFIRLA")).resolves.toBeUndefined();
    expect(initKey(true)).toBe(true);
    expect(keyState()).toBe("ok");
    expect(lstatSync(marker()).isSymbolicLink()).toBe(false);
    expect(readFileSync(marker() + ".x", "utf8")).toBe("dokunma");
    expect(() => mintToken(H, now)).not.toThrow();
  });
  it("aynı durumda --disable da SIFIRLA ile kurtarır (işaret bağı izlenmeden silinir)", async () => {
    initKey();
    rmSync(marker(), { force: true });
    writeFileSync(marker(), "çöp");
    expect(keyState()).toBe("broken");
    await authorizeReset({}, now, async () => "SIFIRLA");
    disableKey();
    expect(existsSync(marker())).toBe(false);
    expect(keyState()).toBe("off");
  });
});
