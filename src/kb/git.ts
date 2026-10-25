import { execFileSync, spawnSync } from "node:child_process";

/** Runs git in `cwd`, returns stdout; a failure throws `git <cmd> başarısız: <stderr>`. */
export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", windowsHide: true });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} başarısız: ${(err.stderr || err.message).trim()}`);
  }
}

/** Like git, but never throws: the caller looks at the exit code. */
export function gitTry(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: (r.stderr || r.error?.message) ?? "" };
}
