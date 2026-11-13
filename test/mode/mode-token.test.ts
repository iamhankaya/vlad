import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKey, mintToken, requireModeAuthority, secretDir, setSecretDirForTests, verifyToken } from "../../src/mode/token.js";
import { modeStatus, setNight } from "../../src/mode/store.js";
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
