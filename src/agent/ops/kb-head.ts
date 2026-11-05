import { execFileSync } from "node:child_process";
import { kbPaths } from "../../kb/home.js";
import { RemoteError } from "../../fleet/types.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** konsol → beyin: kb HEAD ve upstream'e itilmiş mi (vlad-desktop yerel klonu eşitler). */
export async function kbHead(): Promise<{ sha: string; pushed: boolean }> {
  const kb = kbPaths().kb;
  try {
    const sha = git(kb, "rev-parse", "HEAD");
    let pushed = false;
    try { pushed = git(kb, "rev-parse", "@{u}") === sha; } catch { /* upstream yok */ }
    return { sha, pushed };
  } catch (e) {
    throw new RemoteError("failed", `failed: kb git deposu okunamadı: ${(e as Error).message.split("\n")[0]}`);
  }
}
