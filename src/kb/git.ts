import { execFileSync, spawnSync } from "node:child_process";

/**
 * Every kb git call runs hardened (security review D4): the kb clone's `.git/config` is writable by the agent, so
 * hooks and fsmonitor are switched off, system config is skipped and git never prompts.
 */
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const env = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });

/** Hides credentials inside URLs (`https://user:token@host` → `https://***@host`) before git output reaches an error. */
export function maskUrls(s: string): string {
  return s.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@");
}

/** Runs git in `cwd`, returns stdout; a failure throws `git <cmd> başarısız: <stderr>`. */
export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", [...SAFE, ...args], { cwd, encoding: "utf8", stdio: "pipe", windowsHide: true, env: env() });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} başarısız: ${maskUrls((err.stderr || err.message).trim())}`);
  }
}

/** Like git, but never throws: the caller looks at the exit code. */
export function gitTry(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("git", [...SAFE, ...args], { cwd, encoding: "utf8", windowsHide: true, env: env() });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: maskUrls((r.stderr || r.error?.message) ?? "") };
}
