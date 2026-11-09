import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capUtf8, interpreterFor, parseResultLine, runScript, scriptEnv, sweepScriptDir } from "../../src/agent/scripts/run.js";
import { SCRIPT_RESULT_SENTINEL } from "../../src/fleet/types.js";

// Çalıştırma katmanı (T20261109-07): ortam allowlist'i, yorumlayıcı, çıktı sınırı, sentinel, zaman aşımı.

const S = SCRIPT_RESULT_SENTINEL;
const posix = it.skipIf(process.platform === "win32");

describe("parseResultLine", () => {
  it("son 20 satırda sondan ilk sentinel satırının JSON nesnesi", () => {
    const out = ["log", `${S} {"ok":false}`, "daha log", `${S} {"ok":true,"summary":"s"}`, "uyarı: x"].join("\n");
    expect(parseResultLine(out)).toEqual({ data: { ok: true, summary: "s" } });
  });
  it("CRLF satır sonları kabul edilir", () => {
    expect(parseResultLine(`a\r\n${S} {"ok":true}\r\n`)).toEqual({ data: { ok: true } });
    expect(parseResultLine(`\uFEFF${S} {"ok":true}\n`)).toEqual({ data: { ok: true } }); // PS 5.1 BOM
  });
  it("sentinel son 20 satırın dışındaysa görülmez", () => {
    const out = [`${S} {"ok":true}`, ...Array.from({ length: 20 }, (_, i) => `l${i}`)].join("\n");
    expect(parseResultLine(out)).toEqual({ data: null, dataError: "no_result_line" });
  });
  it("hiç sentinel yok → no_result_line", () => {
    expect(parseResultLine("sadece log")).toEqual({ data: null, dataError: "no_result_line" });
  });
  it("JSON değil / nesne değil → bad_json", () => {
    for (const bad of ["{x", "[1]", "5", "null", '"s"']) expect(parseResultLine(`${S} ${bad}`), bad).toEqual({ data: null, dataError: "bad_json" });
  });
  it("16 KiB'ı aşan JSON → too_large", () => {
    expect(parseResultLine(`${S} ${JSON.stringify({ ok: true, pad: "a".repeat(17_000) })}`)).toEqual({ data: null, dataError: "too_large" });
  });
  it("betiğin JSON'undaki restart alanı atılır (yalnız Agent koyar)", () => {
    expect(parseResultLine(`${S} {"ok":true,"restart":"scheduled"}`).data).toEqual({ ok: true });
  });
});

describe("scriptEnv", () => {
  const src = {
    PATH: "/bin", Path: "C:\\x", HOME: "/h", USERPROFILE: "C:\\u", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LANG: "tr_TR",
    GH_TOKEN: "sır", ANTHROPIC_API_KEY: "sır", VLAD_LOCAL_FILE: "/k", VLAD_FORWARDED: "1", VLAD_AGENT_TEST: "1", NODE_OPTIONS: "--inspect", SSH_AUTH_SOCK: "/s",
  } as NodeJS.ProcessEnv;
  const o = { home: "/home", repo: "/repo", machine: "win", opId: "op1", script: "x", params: { "dry-run": "true", root: "C:\\dev" }, roots: ["C:\\dev", "D:\\src"] };
  it("yalnız allowlist: sistem değişkenleri geçer, sırlar ve VLAD_LOCAL_FILE/FORWARDED/AGENT_* geçmez", () => {
    const e = scriptEnv(src, o);
    for (const k of ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "LANG", "SSH_AUTH_SOCK"]) expect(e, k).toHaveProperty(k);
    for (const k of ["GH_TOKEN", "ANTHROPIC_API_KEY", "VLAD_LOCAL_FILE", "VLAD_FORWARDED", "VLAD_AGENT_TEST", "NODE_OPTIONS"]) expect(e, k).not.toHaveProperty(k);
  });
  it("VLAD_* değişkenleri, parametreler (`-`→`_`, büyük harf) ve git istemi kapatma", () => {
    const e = scriptEnv(src, o);
    expect(e).toMatchObject({
      VLAD_HOME: "/home", VLAD_REPO: "/repo", VLAD_MACHINE: "win", VLAD_OP_ID: "op1", VLAD_SCRIPT: "x",
      VLAD_PARAM_DRY_RUN: "true", VLAD_PARAM_ROOT: "C:\\dev", VLAD_ROOTS: "C:\\dev;D:\\src", GIT_TERMINAL_PROMPT: "0",
    });
  });
  it("kaynaktaki VLAD_PARAM_*/VLAD_ROOTS betik parametresi olarak sızdırılamaz", () => {
    const e = scriptEnv({ ...src, VLAD_PARAM_SAHTE: "x", VLAD_ROOTS: "/etc" }, { ...o, params: {} });
    expect(e).not.toHaveProperty("VLAD_PARAM_SAHTE");
    expect(e.VLAD_ROOTS).toBe("C:\\dev;D:\\src");
  });
});

describe("interpreterFor", () => {
  it("Windows: mutlak System32 powershell, profil/etkileşim/policy bayrakları, -File", () => {
    const i = interpreterFor("ps1", "win32", "C:\\Windows");
    expect(i.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(i.args("C:\\t\\a.ps1")).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\t\\a.ps1"]);
  });
  it("POSIX: /bin/bash --noprofile --norc", () => {
    const i = interpreterFor("sh", "darwin", undefined);
    expect(i.file).toBe("/bin/bash");
    expect(i.args("/t/a.sh")).toEqual(["--noprofile", "--norc", "/t/a.sh"]);
  });
  it("uzantı–platform uyumsuzluğu reddedilir", () => {
    expect(() => interpreterFor("ps1", "darwin", undefined)).toThrow(/uyumsuz/);
    expect(() => interpreterFor("sh", "win32", "C:\\Windows")).toThrow(/uyumsuz/);
  });
});

describe("runScript (POSIX)", () => {
  const dirs: string[] = [];
  const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "vlad-run-"))); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const run = (body: string, o: Partial<Parameters<typeof runScript>[0]> = {}) => {
    const d = tmp();
    return runScript({ bytes: Buffer.from(body), name: "t", ext: "sh", opId: "o:1", cwd: d, dir: join(d, "scripts-run"), env: { PATH: process.env.PATH ?? "/usr/bin:/bin", VLAD_PARAM_X: "değer" }, timeoutMs: 10_000, stdoutCapKb: 32, ...o });
  };

  posix("stdout, stderr, çıkış kodu ve süre", async () => {
    const r = await run("echo out; echo err >&2; exit 3");
    expect(r).toMatchObject({ exit: 3, timedOut: false, stdout: "out\n", stderr: "err\n", truncated: { stdout: false, stderr: false }, data: null, dataError: "no_result_line" });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
  posix("yalnız verilen ortam görünür; parametre env'den gelir", async () => {
    process.env.VLAD_TEST_SIR = "sızdı";
    try {
      const r = await run('echo "x=$VLAD_PARAM_X sir=${VLAD_TEST_SIR:-yok}"');
      expect(r.stdout.trim()).toBe("x=değer sir=yok");
    } finally { delete process.env.VLAD_TEST_SIR; }
  });
  posix("sentinel JSON'u data olur", async () => {
    const r = await run(`echo '${S} {"ok":true,"summary":"tamam"}'`);
    expect(r.data).toEqual({ ok: true, summary: "tamam" });
    expect(r.dataError).toBeUndefined();
  });
  posix("zaman aşımı: süreç grubu öldürülür, exit 124, fırlatmaz", async () => {
    const t0 = Date.now();
    const pidBase = join(tmp(), "bg");
    const r = await run('sleep 30 & echo $! > "$PIDBASE.pid"; sleep 30', { timeoutMs: 600, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PIDBASE: pidBase } });
    expect(r).toMatchObject({ exit: 124, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(8000);
    const pid = Number(readFileSync(`${pidBase}.pid`, "utf8").trim());
    await new Promise((res) => setTimeout(res, 300));
    expect(() => process.kill(pid, 0)).toThrow(); // arka plan çocuğu da ölmüş olmalı
  });
  posix("stdout tavanı: sondan kırpılır, truncated işaretlenir, sentinel yine okunur", async () => {
    const r = await run(`yes xxxxxxxxxxxxxxxx | head -c 200000; echo; echo '${S} {"ok":true}'`, { stdoutCapKb: 1 });
    expect(r.truncated.stdout).toBe(true);
    expect(r.stdout.length).toBeLessThan(2 * 1024);
    expect(r.stdout).toContain(S);
    expect(r.data).toEqual({ ok: true });
  });
  posix("tavan UTF-8 bayttır: Türkçe çıktı ≤ tavan bayt, karakter ortadan kesilmez, truncated doğru", async () => {
    const r = await run(`for i in $(seq 1 3000); do printf 'ğüşiöç'; done; echo; echo '${S} {"ok":true}'`, { stdoutCapKb: 1 });
    expect(r.truncated.stdout).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1024);
    expect(r.stdout).not.toContain("\uFFFD");
    expect(r.data).toEqual({ ok: true });
  });
  posix("geçici betik dosyası bitince silinir ve çalışan bayt'lar verilen bayt'lardır", async () => {
    const d = tmp();
    const dir = join(d, "scripts-run");
    const r = await runScript({ bytes: Buffer.from('cat "$0" | head -1'), name: "t", ext: "sh", opId: "o", cwd: d, dir, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000, stdoutCapKb: 32 });
    expect(r.stdout.trim()).toBe('cat "$0" | head -1');
    expect(readdirSync(dir)).toEqual([]);
  });
  posix("başlatılamayan yorumlayıcı başlamadan hata: failed (fırlatır)", async () => {
    const d = tmp();
    await expect(runScript({ bytes: Buffer.from("x"), name: "t", ext: "sh", opId: "o", cwd: join(d, "yok"), dir: join(d, "s"), env: {}, timeoutMs: 1000, stdoutCapKb: 1 })).rejects.toThrow(/failed/);
    expect(existsSync(join(d, "s")) ? readdirSync(join(d, "s")) : []).toEqual([]);
  });
  posix("sweepScriptDir kalıntıları siler", async () => {
    const d = tmp();
    const dir = join(d, "scripts-run");
    await run("true", { dir }); // dizini oluşturur
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "kalinti.sh"), "x");
    sweepScriptDir(dir);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("capUtf8", () => {
  it("tavan altı aynen; üstü marker dahil ≤ cap bayt ve geçerli UTF-8", () => {
    const b = Buffer.from("ğ".repeat(100));
    expect(capUtf8(Buffer.from("abc"), 3, 10)).toBe("abc");
    const out = capUtf8(b, b.length, 51);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(51);
    expect(out).not.toContain("\uFFFD");
    expect(out).toContain("bayt kırpıldı");
  });
});
