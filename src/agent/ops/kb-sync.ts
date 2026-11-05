import { execFile } from "node:child_process";
import { RemoteError } from "../../fleet/types.js";
import { argObject, bad, workerCtx, workerKbDir } from "./worker.js";

const SHA = /^[0-9a-f]{40}$/;
let chain: Promise<unknown> = Promise.resolve(); // tek mutex: eşzamanlı kb-sync sıraya girer

/** Async (execFile): a slow fetch must not freeze the Agent's event loop, so pings keep answering. */
const git = (cwd: string, ...a: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile("git", a, { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (e, stdout, stderr) => {
    // git'in stderr'i yol/URL taşıyabilir: beyne gitmez, işçinin kendi günlüğüne yazılır
    if (e) { console.error(`kb-sync: git ${a[0]}: ${(stderr || e.message).trim().split("\n")[0]}`); reject(new RemoteError("failed", `failed: git ${a[0]} başarısız (ayrıntı işçi günlüğünde)`)); }
    else resolve(stdout.trim());
  });
});

/** Beyin launch/resume öncesi çağırır: fetch + ff-only, sonra beklenen sha'nın HEAD'in atası olduğunu doğrular. */
export async function kbSync(args: unknown): Promise<{ head: string }> {
  const o = argObject(args, ["expectSha"]);
  if (typeof o.expectSha !== "string" || !SHA.test(o.expectSha)) throw bad("expectSha 40 hex olmalı");
  const expect = o.expectSha;
  const run = chain.then(async () => {
    const kb = workerKbDir(workerCtx().def);
    // izlenen dosyalardaki değişiklik = kirli; izlenmeyenler (yerel durum) sayılmaz
    if (await git(kb, "status", "--porcelain", "--untracked-files=no")) throw new RemoteError("failed", "failed: işçi kb ağacı kirli (izlenen dosya değişmiş); elle düzelt");
    await git(kb, "fetch", "--quiet");
    try {
      await git(kb, "merge", "--ff-only", "--quiet", "@{u}");
    } catch {
      throw new RemoteError("failed", "failed: işçi kb klonu ayrışmış ya da upstream yok; ff-only birleştirilemedi");
    }
    // yerel push edilmemiş commit'li klon "beklenen sha atası" denetimini geçse de beyinde olmayan içerik taşır (F-vlad-134)
    if ((await git(kb, "rev-list", "--count", "@{u}..HEAD")) !== "0") throw new RemoteError("failed", "failed: işçi kb klonu upstream'in ilerisinde (push edilmemiş yerel commit var); elle düzelt");
    try { await git(kb, "merge-base", "--is-ancestor", expect, "HEAD"); } catch {
      throw new RemoteError("failed", `failed: beklenen kb sürümü (${expect.slice(0, 8)}) işçide yok; beyin kb'yi push etmemiş olabilir`);
    }
    return { head: await git(kb, "rev-parse", "HEAD") };
  });
  chain = run.catch(() => undefined);
  return await run;
}
