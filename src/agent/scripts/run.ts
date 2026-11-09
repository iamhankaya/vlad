import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ensurePrivateDir, lockDownFile } from "../../fleet/state.js";
import { RemoteError, SCRIPT_LIMITS, SCRIPT_RESULT_SENTINEL, type ScriptRunResult } from "../../fleet/types.js";
import { capText } from "../ops/gate.js";
import { killTree } from "../proc.js";

// Betik çalıştırma: bayt'lar özel geçici dosyaya yazılır (TOCTOU/çalışırken `git pull`/autocrlf), allowlist ortamı, parametre env'den
// (argv/kabuk yok), çıktı tavanı, zaman aşımında süreç ağacı öldürülür. Başladıktan sonra hiçbir yol fırlatmaz.

/** Betiğe geçen sistem değişkenleri (büyük/küçük harf duyarsız; Windows adları). `PROGRAMFILES*` önek eşleşmesi. */
const SYS_ENV = new Set([
  "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA",
  "USERNAME", "LANG", "SSH_AUTH_SOCK", "PROGRAMDATA",
]);
const isSysVar = (k: string): boolean => { const u = k.toUpperCase(); return SYS_ENV.has(u) || u.startsWith("PROGRAMFILES"); };

export interface ScriptEnvOpts { home: string; repo: string; machine: string; opId: string; script: string; params: Record<string, string>; roots: string[] }
/** `process.env` kopyalanmaz: sırlar (GH_TOKEN, ANTHROPIC_API_KEY…), VLAD_LOCAL_FILE/FORWARDED/AGENT_* ve NODE_OPTIONS geçmez. */
export function scriptEnv(src: NodeJS.ProcessEnv, o: ScriptEnvOpts): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && isSysVar(k)) e[k] = v;
  Object.assign(e, { VLAD_HOME: o.home, VLAD_REPO: o.repo, VLAD_MACHINE: o.machine, VLAD_OP_ID: o.opId, VLAD_SCRIPT: o.script, VLAD_ROOTS: o.roots.join(";"), GIT_TERMINAL_PROMPT: "0" });
  for (const [k, v] of Object.entries(o.params)) e[`VLAD_PARAM_${k.toUpperCase().replace(/-/g, "_")}`] = v;
  return e;
}

/** Yorumlayıcı dosya uzantısından türer, manifest belirtemez. PS 5.1: mutlak System32 yolu; parametre argv'de değil env'de. */
export function interpreterFor(ext: "ps1" | "sh", platform: NodeJS.Platform, systemRoot: string | undefined): { file: string; args: (script: string) => string[] } {
  if ((ext === "ps1") !== (platform === "win32")) throw new RemoteError("failed", `failed: [bad_manifest] .${ext} uzantısı ${platform} ile uyumsuz`);
  if (ext === "ps1") {
    return {
      file: win32.join(systemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: (s) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", s],
    };
  }
  return { file: "/bin/bash", args: (s) => ["--noprofile", "--norc", s] };
}

/** Yapılandırılmış sonuç: stdout'un son 20 satırında, sondan ilk `@@VLAD-RESULT@@ {json}`. `restart` yalnız Agent'ındır, betikteki atılır. */
export function parseResultLine(stdout: string): { data: Record<string, unknown> | null; dataError?: "no_result_line" | "bad_json" | "too_large" } {
  const lines = stdout.split("\n").map((l) => l.replace(/\r$/, "")).slice(-20);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.startsWith(`${SCRIPT_RESULT_SENTINEL} `)) continue;
    const json = l.slice(SCRIPT_RESULT_SENTINEL.length + 1);
    if (Buffer.byteLength(json) > SCRIPT_LIMITS.resultJsonKb * 1024) return { data: null, dataError: "too_large" };
    try {
      const v = JSON.parse(json) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) return { data: null, dataError: "bad_json" };
      const { restart: _r, ...rest } = v as Record<string, unknown>;
      return { data: rest };
    } catch { return { data: null, dataError: "bad_json" }; }
  }
  return { data: null, dataError: "no_result_line" };
}

export interface RunSpec {
  bytes: Buffer; name: string; ext: "ps1" | "sh"; opId: string; cwd: string;
  /** geçici betiklerin özel dizini (`<agentDir>/scripts-run`) */
  dir: string;
  env: NodeJS.ProcessEnv; timeoutMs: number; stdoutCapKb: number; platform?: NodeJS.Platform;
}
export type RunOut = Pick<ScriptRunResult, "exit" | "timedOut" | "durationMs" | "stdout" | "stderr" | "truncated" | "data" | "dataError">;

/** Açılışta (ve çökme sonrası) kalan geçici betikleri siler. */
export function sweepScriptDir(dir: string): void {
  try { for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true, recursive: false }); } catch { /* dizin yok */ }
}

/** Başlamadan önceki hatalar (yorumlayıcı yok, dosya yazılamadı) `failed` fırlatır; başladıktan sonra her şey sonuç alanıdır. */
export async function runScript(s: RunSpec): Promise<RunOut> {
  const interp = interpreterFor(s.ext, s.platform ?? process.platform, s.env.SystemRoot ?? process.env.SystemRoot);
  ensurePrivateDir(s.dir);
  const file = join(s.dir, `${s.opId.replace(/[^A-Za-z0-9._-]/g, "_")}-${s.name}-${randomBytes(4).toString("hex")}.${s.ext}`);
  try {
    writeFileSync(file, s.bytes, { flag: "wx", mode: 0o600 });
    lockDownFile(file);
    return await spawnScript(interp.file, interp.args(file), s);
  } finally { try { rmSync(file, { force: true }); } catch { /* Windows: süreç dosyayı tutuyorsa; açılışta süpürülür */ } }
}

function spawnScript(cmd: string, args: string[], s: RunSpec): Promise<RunOut> {
  const outCap = s.stdoutCapKb * 1024, errCap = SCRIPT_LIMITS.stderrKb * 1024;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd: s.cwd, env: s.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "", stderr = "", outTotal = 0, errTotal = 0, started = false, finished = false;
    const dec = [new StringDecoder("utf8"), new StringDecoder("utf8")];
    p.once("spawn", () => { started = true; });
    p.stdout.on("data", (d: Buffer) => { const t = dec[0]!.write(d); outTotal += t.length; stdout = (stdout + t).slice(-2 * outCap); }); // bellek sınırı 2×tavan
    p.stderr.on("data", (d: Buffer) => { const t = dec[1]!.write(d); errTotal += t.length; stderr = (stderr + t).slice(-2 * errCap); });
    const done = (exit: number, timedOut: boolean, extraErr = "") => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      const parsed = parseResultLine(stdout);
      resolve({
        exit, timedOut, durationMs: Date.now() - t0,
        stdout: capText(stdout, outCap), stderr: capText(stderr + extraErr, errCap),
        truncated: { stdout: outTotal > outCap, stderr: errTotal > errCap }, ...parsed,
      });
    };
    // sonucu 'close'u beklemeden ver: torun borulara tutunsa da op asılı kalmaz
    const timer = setTimeout(() => { killTree(p); done(124, true, "\nbetik zaman aşımına uğradı"); }, s.timeoutMs);
    p.on("error", (e) => {
      if (started) return done(1, false, `\n${e.message}`);
      finished = true; clearTimeout(timer);
      reject(new RemoteError("failed", `failed: betik başlatılamadı: ${e.message}`));
    });
    p.on("close", (code) => done(code ?? 1, false));
  });
}
