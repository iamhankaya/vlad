// The only place the server runs git (kb topology note K9). Always in `<stateDir>/repo.git`, a bare clone that `vladapi` owns and fetches
// from GitHub itself; never in the kb clone the agent can write (its `.git/config` is agent-controlled and could run code as `vladapi`).
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitResult { code: number; stdout: string; stderr?: string }
export interface GitCallOptions { input?: string; /** Installation token for the fetch/push; travels in the environment only. */ token?: string; /** Extra environment (commit identity). */ env?: Record<string, string> }
export type GitExec = (args: string[], o?: GitCallOptions) => Promise<GitResult>;
export interface RunLimits { /** kill the process after this long */ timeoutMs: number; /** kill it when this directory grows past `maxBytes` (checked every second) */ watch?: { dir: string; maxBytes: number } }
export type Runner = (file: string, args: string[], o: { cwd: string; env: Record<string, string>; input?: string; limits?: RunLimits }) => Promise<GitResult>;

/** Marker in `stderr` of a run that was killed for growing the clone past its cap. */
export const REPO_TOO_LARGE = "repo_too_large";
/** Marker in `stderr` of a run that was killed for taking too long. */
export const RUN_TIMEOUT = "run_timeout";
export const FETCH_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Cap of the bare clone while fetching and after cleanup (an attacker-controlled branch can carry anything). */
export const MAX_REPO_BYTES = 256 * 1024 * 1024;

export function dirBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    try {
      n += e.isDirectory() ? dirBytes(f) : lstatSync(f).size;
    } catch { /* vanished */ }
  }
  return n;
}

/** Config passed with `-c` on every call: no hooks, https only, objects checked on fetch, no helper that could hold or leak credentials. */
export const HARDENED_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "protocol.allow=never",
  "protocol.https.allow=always",
  "transfer.fsckObjects=true",
  "fetch.fsckObjects=true",
  "submodule.recurse=false",
  "credential.helper=",
  // a stalled transfer is dropped instead of holding the lock: under 1 kB/s for 30 s
  "http.lowSpeedLimit=1000",
  "http.lowSpeedTime=30",
];

export const GATE_IDENTITY = { GIT_AUTHOR_NAME: "vlad-gate", GIT_AUTHOR_EMAIL: "vlad-gate@users.noreply.github.com", GIT_COMMITTER_NAME: "vlad-gate", GIT_COMMITTER_EMAIL: "vlad-gate@users.noreply.github.com" } as const;

const MAX_BUFFER = 64 * 1024 * 1024;

export const spawnRunner: Runner = (file, args, o) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0;
    let why = "";
    const timer = setTimeout(() => { why = RUN_TIMEOUT; child.kill("SIGKILL"); }, o.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const watch = o.limits?.watch;
    const poll = watch
      ? setInterval(() => {
          try {
            if (dirBytes(watch.dir) > watch.maxBytes) { why = REPO_TOO_LARGE; child.kill("SIGKILL"); }
          } catch { /* dir busy */ }
        }, 1000)
      : undefined;
    const take = (into: Buffer[]) => (b: Buffer) => {
      size += b.length;
      if (size > MAX_BUFFER) child.kill("SIGKILL");
      else into.push(b);
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    child.on("error", (e) => { clearTimeout(timer); if (poll) clearInterval(poll); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") + (why ? `\n${why}` : "") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(o.input);
  });

/** Environment of every git call: nothing inherited but PATH, no system or global config, no prompt; the token only as `VLAD_GIT_TOKEN` read by the askpass script. */
export function hardenedEnv(stateDir: string, path: string | undefined, o: GitCallOptions = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...(path ? { PATH: path } : {}),
    HOME: stateDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    ...GATE_IDENTITY, ...o.env,
  };
  if (o.token) {
    env.GIT_ASKPASS = join(stateDir, "askpass.sh");
    env.VLAD_GIT_TOKEN = o.token;
  }
  return env;
}

export function repoDir(stateDir: string): string {
  return join(stateDir, "repo.git");
}

/** Creates the askpass script (answers the username prompt with `x-access-token`, the password prompt with `$VLAD_GIT_TOKEN`) and the bare repository. */
export async function ensureBareRepo(stateDir: string, run: Runner = spawnRunner, path: string | undefined = process.env.PATH): Promise<void> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, "askpass.sh"), '#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) printf %s "$VLAD_GIT_TOKEN" ;;\nesac\n', { mode: 0o700 });
  const dir = repoDir(stateDir);
  if (existsSync(join(dir, "HEAD"))) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const r = await run("git", ["init", "--bare", "-q"], { cwd: dir, env: hardenedEnv(stateDir, path) });
  if (r.code !== 0) throw new Error("kb promote klonu hazırlanamadı");
}

export function createGitExec(o: { stateDir: string; run?: Runner; path?: string | undefined; maxRepoBytes?: number }): GitExec {
  const run = o.run ?? spawnRunner;
  const path = "path" in o ? o.path : process.env.PATH;
  const prefix = HARDENED_CONFIG.flatMap((c) => ["-c", c]);
  const dir = repoDir(o.stateDir);
  const maxBytes = o.maxRepoBytes ?? MAX_REPO_BYTES;
  return (args, call = {}) => {
    const net = args[0] === "fetch" || args[0] === "push" || args[0] === "ls-remote";
    const limits: RunLimits = { timeoutMs: net ? FETCH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS, ...(args[0] === "fetch" ? { watch: { dir, maxBytes } } : {}) };
    return run("git", [...prefix, ...args], { cwd: dir, env: hardenedEnv(o.stateDir, path, call), input: call.input, limits });
  };
}

/** Port the writer uses: reads the first parent of the commit it is about to publish and publishes it without force. */
export interface KbGitPort {
  firstParent(commit: string): Promise<string>;
  push(o: { token: string; commit: string; ref: string; expectedMain: string }): Promise<"pushed" | "rejected">;
}

export function createKbGitPort(git: GitExec, url: string): KbGitPort {
  return {
    async firstParent(commit) {
      const r = await git(["rev-parse", "--verify", "-q", `${commit}^1`]);
      if (r.code !== 0) throw new Error("kb commit'in ebeveyni okunamadı");
      return r.stdout.trim();
    },
    async push({ token, commit, ref, expectedMain }) {
      // no `+` refspec and no plain force: GitHub refuses anything that is not a fast-forward, and the lease says "only if main is still the main we
      // validated against" (finding 8); --atomic makes the one ref update all-or-nothing
      const r = await git(["push", "-q", "--atomic", `--force-with-lease=${ref}:${expectedMain}`, url, `${commit}:${ref}`], { token });
      if (r.code === 0) return "pushed";
      if (/\[(remote )?rejected\]|non-fast-forward|fetch first|stale info/i.test(r.stderr ?? "")) return "rejected";
      throw new Error("kb push başarısız (ağ ya da yetki)");
    },
  };
}

/**
 * After a run that fetched something we will not keep (a refused branch): drops the tracking ref of the server branch and every reflog entry,
 * prunes, and starts the clone over when it is still past its cap. Never throws.
 */
export async function discardFetched(git: GitExec, stateDir: string, branchRef: string, maxBytes = MAX_REPO_BYTES): Promise<void> {
  try {
    await git(["update-ref", "-d", branchRef]);
    await git(["reflog", "expire", "--expire=now", "--all"]);
    await git(["gc", "-q", "--prune=now"]);
    if (dirBytes(repoDir(stateDir)) > maxBytes) {
      rmSync(repoDir(stateDir), { recursive: true, force: true });
      await ensureBareRepo(stateDir);
    }
  } catch { /* best effort: the next run starts from whatever is there */ }
}
