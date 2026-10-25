// T13 (T20261025-90): ortak kurulum. Geçici bare remote (`file://`) + her makine için bir kb klonu.
// Tasarım: docs/superpowers/specs/2026-10-25-vlad-kb-topology.md (S13a). İki klon = iki makine (`VLAD_MACHINE`).
// Üretim koduna dokunmaz: CLI yalnız `dist/cli.js` alt süreci olarak koşar.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..", "..");
export const CLI = join(REPO_ROOT, "dist", "cli.js");

/** Kök `dist/` yoksa (sunucu paketi tek başına koşarken) bir kez derler; üretim kodu değişmez. */
export function ensureBuilt(): void {
  if (existsSync(CLI)) return;
  const r = spawnSync("npx", ["tsc"], { cwd: REPO_ROOT, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}${r.stderr}`);
}

export const IDENT = {
  GIT_AUTHOR_NAME: "T13", GIT_AUTHOR_EMAIL: "t13@example.test", GIT_COMMITTER_NAME: "T13", GIT_COMMITTER_EMAIL: "t13@example.test",
};

export type Env = Record<string, string | undefined>;
export interface Run { code: number | null; out: string; err: string }

/** Çıplak git (kimlikli). `protocol.file.allow` açmaz: fetch/push `file://` için gerekmez. */
export function git(cwd: string, args: string[], o: { input?: string; env?: Env } = {}): string {
  const env: Env = { ...process.env, ...IDENT, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...o.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return execFileSync("git", args, { cwd, encoding: "utf8", input: o.input, stdio: ["pipe", "pipe", "pipe"], env: env as NodeJS.ProcessEnv }).trim();
}

/** Makine adlandırması: `server` rolü `process` launcher + `kbPushBranch: kb-server`, `windows` rolü `wt` launcher. */
export type Role = "windows" | "server";

export interface Machine {
  name: string;
  role: Role;
  home: string;
  /** kb klonu (VLAD_KB_DIR) */
  kb: string;
  env: Env;
  git(...args: string[]): string;
  run(args: string[], o?: { input?: string; env?: Env }): Run;
  runAsync(args: string[], o?: { env?: Env }): Promise<Run>;
  /** `--json` ekler, çıkış 0 bekler, stdout JSON döner. */
  ok<T = any>(args: string[], o?: { input?: string; env?: Env }): T;
  /** `--json` ekler, çıkış 1 bekler, `{error, details}` döner. */
  fail(args: string[], o?: { input?: string; env?: Env }): { error: string; details: unknown[] };
  write(rel: string, text: string): void;
  read(rel: string): string;
  exists(rel: string): boolean;
  /** Proje kartını / active.md'yi düz dosya olarak okur. */
  activeMachine(): string | null;
}

export interface World {
  /** bare remote (yol) */
  remote: string;
  url: string;
  machines: Record<string, Machine>;
  /** Uzaktaki bir dalın SHA'sı (yoksa null). */
  remoteHead(branch: string): string | null;
  remoteGit(...args: string[]): string;
  /** `origin/main` içindeki dosya (yoksa null). */
  mainFile(rel: string): string | null;
  /**
   * Temiz bir promote'un yaptığı işin yerine geçer (S13c'nin gerçek `promoteKb`'si bu dosyada kullanılmaz):
   * uzaktaki `kb-server`'ı `main`'e `--no-ff` merge commit'i olarak indirir ve push eder. Çakışırsa fırlatır.
   */
  landServerBranchOnMain(): string;
  /** Çalışma klonu olmadan kurulan commit'ler için geçici klon (uzaktan yeni bir klon). */
  scratch(branch?: string): string;
}

const KB_GITIGNORE = ["inbox/", "logs/", "vlad-session.txt", ".vlad.lock", "cards/*.lock"];

export const SEED_CARD = (extra = "") => `---
slug: alpha
name: alpha
path: /nonexistent/alpha
paths:
  winbox: C:\\dev\\alpha
repo: acme/alpha
default_branch: main
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
${extra}---

## Özet
x
`;

function runCli(m: { home: string; kb: string; name: string; env: Env }, args: string[], o: { input?: string; env?: Env } = {}): Run {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", input: o.input, env: cleanEnv(m, o.env) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function cleanEnv(m: { home: string; kb: string; name: string; env: Env }, extra: Env = {}): NodeJS.ProcessEnv {
  const e: Env = {
    ...process.env, ...IDENT, ...m.env, ...extra,
    VLAD_HOME: m.home, VLAD_KB_DIR: m.kb, VLAD_MACHINE: m.name,
    CLAUDE_CODE_REMOTE: undefined, CLAUDE_CODE_REMOTE_SESSION_ID: undefined, VLAD_TASK_ID: undefined,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e as NodeJS.ProcessEnv;
}

export interface WorldOpts {
  /** varsayılan: windows `winbox`, server `srvbox` */
  machines?: Array<{ name: string; role: Role }>;
  /** ana dalın başlangıç dosyalarını genişletir */
  seed?: Record<string, string>;
}

/** Remote + ana dalda tohum içerik + makine klonları. `kb-server` dalı sunucu klonundan oluşturulup push edilir. */
export function makeWorld(o: WorldOpts = {}): World {
  ensureBuilt();
  const base = mkdtempSync(join(tmpdir(), "vlad-t13-"));
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote], { env: { ...process.env, ...IDENT } });
  const url = `file://${remote}`;
  const rgit = (...a: string[]) => git(remote, a);

  // tohum: ayrı bir klondan main'e ilk commit
  const seed = join(base, "seed");
  git(base, ["clone", "-q", url, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  const seedFiles: Record<string, string> = {
    ".gitignore": KB_GITIGNORE.join("\n") + "\n",
    "projects/alpha.md": SEED_CARD(),
    "decisions.md": "# Karar günlüğü\n",
    "journal/2026-10-25.md": "# 2026-10-25\n",
    ...o.seed,
  };
  for (const [rel, text] of Object.entries(seedFiles)) {
    mkdirSync(dirname(join(seed, rel)), { recursive: true });
    writeFileSync(join(seed, rel), text);
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "seed"]);
  git(seed, ["push", "-q", "origin", "main"]);

  const spec = o.machines ?? [{ name: "winbox", role: "windows" as Role }, { name: "srvbox", role: "server" as Role }];
  const machines: Record<string, Machine> = {};
  for (const { name, role } of spec) {
    const home = join(base, `home-${name}`);
    const kb = join(home, "..", `kb-${name}`);
    mkdirSync(home, { recursive: true });
    cpSync(join(REPO_ROOT, "schemas"), join(home, "schemas"), { recursive: true });
    git(base, ["clone", "-q", url, kb]);
    for (const d of ["projects", "tasks", "findings", "cards", "grants", "journal", "inbox/processed", "logs"]) mkdirSync(join(kb, d), { recursive: true });
    const machineCfg = role === "server" ? { launcher: "process", kbPushBranch: "kb-server" } : { launcher: "wt" };
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ kbDir: kb, machines: { [name]: machineCfg } }));
    if (role === "server") {
      git(kb, ["switch", "-q", "-c", "kb-server"]);
      git(kb, ["push", "-q", "-u", "origin", "kb-server"]);
    }
    const m: Machine = {
      name, role, home, kb, env: {},
      git: (...a) => git(kb, a),
      run: (args, oo) => runCli(m, args, oo),
      runAsync: (args, oo = {}) =>
        new Promise((res) => {
          const c = spawn("node", [CLI, ...args], { env: cleanEnv(m, oo.env) });
          let out = "", err = "";
          c.stdout.on("data", (d) => (out += d));
          c.stderr.on("data", (d) => (err += d));
          c.on("close", (code) => res({ code, out, err }));
        }),
      ok: (args, oo) => {
        const r = runCli(m, [...args, "--json"], oo);
        if (r.code !== 0) throw new Error(`${name}: vlad ${args.join(" ")} -> çıkış ${r.code}\n${r.err}`);
        return JSON.parse(r.out);
      },
      fail: (args, oo) => {
        const r = runCli(m, [...args, "--json"], oo);
        if (r.code !== 1) throw new Error(`${name}: vlad ${args.join(" ")} başarısız olmalıydı (çıkış ${r.code}); stdout=${r.out}`);
        const e = JSON.parse(r.err.trim().split("\n").filter(Boolean).pop() ?? "{}");
        return e;
      },
      write: (rel, text) => {
        mkdirSync(dirname(join(kb, rel)), { recursive: true });
        writeFileSync(join(kb, rel), text);
      },
      read: (rel) => readFileSync(join(kb, rel), "utf8"),
      exists: (rel) => existsSync(join(kb, rel)),
      activeMachine: () => {
        if (!existsSync(join(kb, "active.md"))) return null;
        return /^machine:\s*(\S+)/m.exec(readFileSync(join(kb, "active.md"), "utf8"))?.[1] ?? null;
      },
    };
    machines[name] = m;
  }

  const world: World = {
    remote, url, machines,
    remoteGit: rgit,
    remoteHead: (b) => {
      try { return rgit("rev-parse", "--verify", "-q", `refs/heads/${b}`); } catch { return null; }
    },
    mainFile: (rel) => {
      try { return rgit("show", `refs/heads/main:${rel}`); } catch { return null; }
    },
    scratch: (branch = "main") => {
      const d = mkdtempSync(join(base, "scratch-"));
      git(base, ["clone", "-q", "--branch", branch, url, d]);
      return d;
    },
    landServerBranchOnMain: () => {
      const d = world.scratch("main");
      git(d, ["fetch", "-q", "origin", "kb-server"]);
      git(d, ["merge", "-q", "--no-ff", "--no-edit", "origin/kb-server"]);
      git(d, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
      return git(d, ["rev-parse", "HEAD"]);
    },
  };
  return world;
}

/** Bir dosyayı yazıp `vlad kb commit --push` ile main'e iter (windows rolü). */
export function commitPush(m: Machine, message: string): any {
  return m.ok(["kb", "commit", message, "--push"]);
}

export const iso = (ms: number) => new Date(ms).toISOString();

/** Aktif makinede görev açar ve dosyada `running` yapar (cloud-helpers.forceRunning kalıbı). */
export function newRunningTask(m: Machine, project = "alpha"): string {
  const id = m.ok<{ id: string }>(["task", "new", "--project", project, "--title", "T13 görevi", "--kind", "dev", "--body-file", "-"], { input: "## Tanım\nx\n" }).id;
  const rel = readdirSync(join(m.kb, "tasks")).find((n) => n.startsWith(id))!;
  m.write(`tasks/${rel}`, m.read(`tasks/${rel}`).replace("state: queued", "state: running"));
  return id;
}

/** Görev dosyasının kb içindeki göreli yolu. */
export const taskRel = (m: Machine, id: string): string => `tasks/${readdirSync(join(m.kb, "tasks")).find((n) => n.startsWith(id))!}`;
