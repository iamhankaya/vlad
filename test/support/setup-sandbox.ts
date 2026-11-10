// `vlad setup` kabul testleri için sandbox (T20261110-04; spec T20261110-02 "Kabul senaryoları").
// Her sandbox: geçici HOME/USERPROFILE/VLAD_CLAUDE_DIR, repo kopyası (VLAD_HOME; dist/ isteğe bağlı), sahte araçlar (PATH başında;
// çağrılar FAKE_LOG'a yazılır), VLAD_NO_NATIVE=1 + VLAD_LAUNCHER=noop. Gerçek ~/.claude, kb ve ana reponun node_modules'üne dokunulmaz.
// Varsayım (spec'te adı yok; uygulama karar versin): `VLAD_SETUP_PLATFORM=win32|darwin|linux` setup'ın platformunu geçersiz kılar (test için).
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { delimiter, join, relative, resolve } from "node:path";
import { assertInside, makeFixtureRoot } from "../helpers.js";
import { resolveTool, toolInvocation } from "../../src/setup/io.js";

export const repoRoot = resolve(import.meta.dirname, "..", "..");
export const cliJs = join(repoRoot, "dist", "cli.js");

const FAKE_TOOLS: Record<string, string> = {
  tmux: 'echo "tmux 3.8"',
  claude: 'case "$1" in --version) echo "2.1.319 (Claude Code)";; --help) echo "  --autocompact <n>  auto compact window";; *) :;; esac',
  codex: 'echo "codex-cli 0.166.0"',
  // gh: auth/repo view başarılı (FAKE_GH_VIEW_FAIL=1 ile repo view hata); repo clone, FAKE_GH_BARE'den git clone yapar
  gh: 'case "$1 $2" in "repo view") [ -n "$FAKE_GH_VIEW_FAIL" ] && { echo "not found" >&2; exit 1; }; echo "{}";; "repo clone") git clone -q "$FAKE_GH_BARE" "$4" ;; *) :;; esac',
  launchctl: ":", schtasks: ":", reg: ":", osascript: ":", systemctl: ":",
};
const LOGGED_TOOLS = ["gh", "launchctl", "schtasks", "reg", "osascript", "systemctl"];

export interface Sandbox {
  root: string; home: string; claudeDir: string; vladHome: string; kbDir: string; bin: string; log: string;
  /** vlad setup (ve diğer komutlar); gerçek dist/cli.js, sahte araçlar PATH başında. */
  run(args: string[], o?: { input?: string; env?: Record<string, string>; cwd?: string }): { code: number | null; out: string; err: string };
  /** Sahte araç çağrıları (`<araç> <argv>` satırları). */
  calls(): string[];
  /** Her sahte araç, setup'ın kullandığı çözümlemeyle (Windows: PATH+PATHEXT) 'bin'deki dosyaya çözülmeli; gerçek araca düşerse fırlatır (F-vlad-310). */
  assertFakesResolve(): void;
  /** Sahte aracı setup'ın çağırdığı biçimde çalıştırır (win32: .cmd sarmalayıcı). */
  runTool(name: string, args: string[]): { code: number | null; out: string; err: string };
  settings(): any;
  writeSettings(s: unknown | string): string;
  answers(a: Record<string, unknown>): string;
}

/** Windows: Git for Windows'in sh.exe'si (git.exe'nin yanından ya da PATH'ten). */
function findSh(): string {
  const git = resolveTool("git");
  const cands = [git && join(git, "..", "..", "bin", "sh.exe"), git && join(git, "..", "..", "usr", "bin", "sh.exe"), resolveTool("sh")].filter((c): c is string => !!c);
  const f = cands.find((c) => existsSync(c));
  if (!f) throw new Error("setup sandbox: Windows'ta sahte araçlar için Git'in sh.exe'si bulunamadı");
  return f;
}

const SKIP = new Set(["node_modules", "dist", ".git", "test", "docs", "vendor"]);

export function makeSandbox(o: { withDist?: boolean; platform?: "win32" | "darwin" | "linux" } = {}): Sandbox {
  const root = makeFixtureRoot();
  const home = join(root, "home"), vladHome = join(root, "dev", "vlad"), kbDir = join(root, "dev", "vlad-kb"), bin = join(root, "bin");
  const claudeDir = join(home, ".claude"), log = join(root, "fake-calls.log");
  for (const d of [home, vladHome, bin, join(root, "dev")]) mkdirSync(d, { recursive: true });
  assertInside(root, vladHome);
  // repo kopyası: kaynak/şema/skill dosyaları; dist en son (src'den yeni kalsın)
  for (const e of readdirSync(repoRoot)) if (!SKIP.has(e) && e !== ".claude") cpSync(join(repoRoot, e), join(vladHome, e), { recursive: true });
  cpSync(join(repoRoot, ".claude"), join(vladHome, ".claude"), { recursive: true, filter: (s) => !s.endsWith("settings.local.json") });
  cpSync(join(repoRoot, "vendor"), join(vladHome, "vendor"), { recursive: true });
  if (o.withDist !== false) cpSync(join(repoRoot, "dist"), join(vladHome, "dist"), { recursive: true });
  for (const [name, body] of Object.entries(FAKE_TOOLS)) {
    const logLine = LOGGED_TOOLS.includes(name) ? `echo "${name} $*" >> "$FAKE_LOG"\n` : "";
    const f = join(bin, name);
    writeFileSync(f, `#!/bin/sh\n${logLine}${body}\n`);
    chmodSync(f, 0o755);
    // Windows: CreateProcess uzantısız dosyayı çözmez (gerçek gh.exe çağrılırdı); .cmd sarmalayıcı PATHEXT ile bulunur, gövdeyi Git'in sh'ı çalıştırır
    if (process.platform === "win32") writeFileSync(join(bin, name + ".cmd"), `@"${findSh()}" "%~dp0${name}" %*
`);
  }
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const e: Record<string, string> = {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: home, USERPROFILE: home, VLAD_CLAUDE_DIR: claudeDir, VLAD_HOME: vladHome,
      VLAD_NO_NATIVE: "1", VLAD_TEST: "1", VLAD_LAUNCHER: "noop", VLAD_CLAUDE_JSON: join(root, "claude.json"), FAKE_LOG: log, CLAUDE_CODE_REMOTE: "",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid",
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1", ...extra,
    };
    for (const k of ["SYSTEMROOT", "COMSPEC", "PATHEXT", "TMPDIR", "TEMP", "TMP"]) if (process.env[k] !== undefined) e[k] = process.env[k] as string;
    if (o.platform) e.VLAD_SETUP_PLATFORM = o.platform;
    return e;
  };
  return {
    root, home, claudeDir, vladHome, kbDir, bin, log,
    run(args0, ro = {}) {
      // Onay artık cevap dosyasında değil `--confirm` bayrağında (T20261110-05 güvenlik kararı): testlerin cevaplarındaki confirm bayrağa taşınır.
      const args = [...args0];
      const ai = args.indexOf("--answers");
      if (ai >= 0 && args[ai + 1]?.trim().startsWith("{")) {
        const a = JSON.parse(args[ai + 1]!);
        if (a.confirm !== undefined) { args.push("--confirm", (a.confirm as string[]).join(",")); delete a.confirm; args[ai + 1] = JSON.stringify(a); }
      }
      this.assertFakesResolve();
      const r = spawnSync(process.execPath, [cliJs, ...args], { encoding: "utf8", env: env(ro.env), input: ro.input, cwd: ro.cwd ?? vladHome, timeout: 60_000, killSignal: "SIGKILL" });
      return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
    },
    assertFakesResolve() {
      const e = env();
      for (const name of Object.keys(FAKE_TOOLS)) {
        const found = process.platform === "win32" ? resolveTool(name, e) : (e.PATH ?? "").split(delimiter).map((d) => join(d, name)).find((f) => existsSync(f));
        if (!found || resolve(found, "..").toLowerCase() !== resolve(bin).toLowerCase()) throw new Error(`setup sandbox: '${name}' sahte araca çözülmüyor (çözülen: ${found ?? "yok"}); gerçek araç çağrılırdı`);
      }
    },
    runTool(name, args) {
      const inv = toolInvocation(name, args, env(), process.platform);
      const r = spawnSync(inv.file, inv.args, { encoding: "utf8", env: env(), windowsVerbatimArguments: inv.verbatim, timeout: 30_000, killSignal: "SIGKILL" });
      return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
    },
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    settings: () => JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")),
    writeSettings(s) {
      mkdirSync(claudeDir, { recursive: true });
      const f = join(claudeDir, "settings.json");
      writeFileSync(f, typeof s === "string" ? s : JSON.stringify(s, null, 2) + "\n");
      return f;
    },
    answers: (a) => JSON.stringify(a),
  };
}

/** S1 cevabı (Mac, tek makine, yerel kb); `over` üst düzey anahtarları değiştirir. */
export const s1Answers = (sb: Sandbox, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  role: "brain", machines: "single", fresh: true, kb: { mode: "local", dir: sb.kbDir }, roots: [join(sb.root, "dev")], ...over,
});

/** Dizin ağacının içerik karması (göreli yol → sha256); mtime dahil değil (ayrı `mtimes`). */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}
export function mtimes(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(snapshot(dir))) out[k] = statSync(join(dir, k)).mtimeMs;
  return out;
}
export const backups = (claudeDir: string): string[] => (existsSync(claudeDir) ? readdirSync(claudeDir).filter((f) => f.startsWith("settings.json.bak-")) : []);
export const SECRET_RE = /[0-9a-f]{64}/;
export const gitInit = (dir: string, ...extra: string[]): void => { mkdirSync(dir, { recursive: true }); execFileSync("git", ["init", "-q", ...extra, dir]); };
