import { execFileSync } from "node:child_process";
import { RemoteError } from "../../machines/types.js";
import { argObject, bad, workerCtx, workerKbDir } from "./worker.js";

const SHA = /^[0-9a-f]{40}$/;
let chain: Promise<unknown> = Promise.resolve(); // tek mutex: eşzamanlı kb-sync sıraya girer

const git = (cwd: string, ...a: string[]): string => {
  try {
    return execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new RemoteError("failed", `failed: git ${a[0]}: ${(err.stderr || err.message).trim().split("\n")[0]}`);
  }
};

/** Beyin launch/resume öncesi çağırır: fetch + ff-only, sonra beklenen sha'nın HEAD'in atası olduğunu doğrular. */
export async function kbSync(args: unknown): Promise<{ head: string }> {
  const o = argObject(args, ["expectSha"]);
  if (typeof o.expectSha !== "string" || !SHA.test(o.expectSha)) throw bad("expectSha 40 hex olmalı");
  const expect = o.expectSha;
  const run = chain.then(() => {
    const kb = workerKbDir(workerCtx().def);
    // izlenen dosyalardaki değişiklik = kirli; izlenmeyenler (yerel durum) sayılmaz
    if (git(kb, "status", "--porcelain", "--untracked-files=no")) throw new RemoteError("failed", "failed: işçi kb ağacı kirli (izlenen dosya değişmiş); elle düzelt");
    git(kb, "fetch", "--quiet");
    try {
      git(kb, "merge", "--ff-only", "--quiet", "@{u}");
    } catch {
      throw new RemoteError("failed", "failed: işçi kb klonu ayrışmış ya da upstream yok; ff-only birleştirilemedi");
    }
    try { git(kb, "merge-base", "--is-ancestor", expect, "HEAD"); } catch {
      throw new RemoteError("failed", `failed: beklenen kb sürümü (${expect.slice(0, 8)}) işçide yok; beyin kb'yi push etmemiş olabilir`);
    }
    return { head: git(kb, "rev-parse", "HEAD") };
  });
  chain = run.catch(() => undefined);
  return await run;
}
