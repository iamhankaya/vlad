// The only place the server runs git (kb topology note K9). Always in `<stateDir>/repo.git`, a bare clone that `vladapi` owns and fetches
// from GitHub itself; never in the kb clone the agent can write (its `.git/config` is agent-controlled and could run code as `vladapi`).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitResult { code: number; stdout: string; stderr?: string }
export interface GitCallOptions { input?: string; /** Installation token for the fetch/push; travels in the environment only. */ token?: string; /** Extra environment (commit identity). */ env?: Record<string, string> }
export type GitExec = (args: string[], o?: GitCallOptions) => Promise<GitResult>;
export type Runner = (file: string, args: string[], o: { cwd: string; env: Record<string, string>; input?: string }) => Promise<GitResult>;

/** Config passed with `-c` on every call: no hooks, https only, objects checked on fetch, no helper that could hold or leak credentials. */
export const HARDENED_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "protocol.allow=never",
  "protocol.https.allow=always",
  "transfer.fsckObjects=true",
  "fetch.fsckObjects=true",
  "submodule.recurse=false",
  "credential.helper=",
];

export const GATE_IDENTITY = { GIT_AUTHOR_NAME: "vlad-gate", GIT_AUTHOR_EMAIL: "vlad-gate@users.noreply.github.com", GIT_COMMITTER_NAME: "vlad-gate", GIT_COMMITTER_EMAIL: "vlad-gate@users.noreply.github.com" } as const;

const MAX_BUFFER = 64 * 1024 * 1024;

export const spawnRunner: Runner = (file, args, o) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0;
    const take = (into: Buffer[]) => (b: Buffer) => {
      size += b.length;
      if (size > MAX_BUFFER) child.kill("SIGKILL");
      else into.push(b);
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
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

export function createGitExec(o: { stateDir: string; run?: Runner; path?: string | undefined }): GitExec {
  const run = o.run ?? spawnRunner;
  const path = "path" in o ? o.path : process.env.PATH;
  const prefix = HARDENED_CONFIG.flatMap((c) => ["-c", c]);
  return (args, call = {}) => run("git", [...prefix, ...args], { cwd: repoDir(o.stateDir), env: hardenedEnv(o.stateDir, path, call), input: call.input });
}

/** Port the writer uses: reads the first parent of the commit it is about to publish and publishes it without force. */
export interface KbGitPort {
  firstParent(commit: string): Promise<string>;
  push(o: { token: string; commit: string; ref: string }): Promise<"pushed" | "rejected">;
}

export function createKbGitPort(git: GitExec, url: string): KbGitPort {
  return {
    async firstParent(commit) {
      const r = await git(["rev-parse", "--verify", "-q", `${commit}^1`]);
      if (r.code !== 0) throw new Error("kb commit'in ebeveyni okunamadı");
      return r.stdout.trim();
    },
    async push({ token, commit, ref }) {
      // no `+`, no force flag: GitHub refuses anything that is not a fast-forward of the current ref
      const r = await git(["push", "-q", url, `${commit}:${ref}`], { token });
      if (r.code === 0) return "pushed";
      if (/\[(remote )?rejected\]|non-fast-forward|fetch first|stale info/i.test(r.stderr ?? "")) return "rejected";
      throw new Error("kb push başarısız (ağ ya da yetki)");
    },
  };
}
