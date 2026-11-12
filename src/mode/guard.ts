import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { assertNotWorker as assertNotWorkerEnv } from "./store.js";

/** F-vlad-287: `env -u VLAD_TASK_ID` ile aşılmasın: cwd `vlad/T…` dalındaysa (çalışan/faz worktree'si) da çalışan sayılır. Git yoksa/hata: çalışan değil. */
function inWorkerBranch(cwd: string): boolean {
  try { return /^vlad\/T\d{8}-\d+$/.test(execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim()); } catch { return false; }
}

/**
 * F-vlad-287 EK DAYANAK, güvenlik sınırı DEĞİL: cwd (ya da üst dizini) `<repo>-wt/T<yyyymmdd>-<n>` ise çalışan worktree'sidir; dal adı değişse, detached HEAD olsa, git yok olsa da geçerli.
 * Worktree dışına cd + env -u ya da kb/mode.json'a doğrudan yazma bunu aşar; gerçek sınır (izin kümesi deny / imzalı token) F-vlad-287'nin kalanı olarak izlenir.
 * Büyük/küçük harf duyarsız (macOS/Windows dosya sistemleri); yol `realpathSync.native` ile gerçek yazımına çevrilir. Çözülemezse fail-closed: çalışan sayılır.
 */
export function inWorkerWorktreeDir(cwd: string): boolean {
  let d: string;
  try { d = realpathSync.native(cwd); } catch { return true; }
  for (;;) {
    const parent = dirname(d);
    if (parent === d) return false;
    if (/^T\d{8}-\d+$/i.test(basename(d)) && /-wt$/i.test(basename(parent))) return true;
    d = parent;
  }
}

/** Mod yazan komutların koruması: ortam değişkeni, cwd dalı VE cwd worktree yolu (çalışan oturumu mod açamaz/kapatamaz). */
export function assertNotWorker(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): void {
  assertNotWorkerEnv(env);
  if (inWorkerBranch(cwd) || inWorkerWorktreeDir(cwd)) throw new Error("çalışan oturumu mod yazamaz (cwd vlad/T… çalışan dalında ya da <repo>-wt/T… worktree'sinde); ana repo dizininden çalıştırın; yetki penceresini yalnız VLAD/kullanıcı açar");
}
