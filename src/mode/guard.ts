import { execFileSync } from "node:child_process";
import { assertNotWorker as assertNotWorkerEnv } from "./store.js";

/** F-vlad-287: `env -u VLAD_TASK_ID` ile aşılmasın: cwd `vlad/T…` dalındaysa (çalışan/faz worktree'si) da çalışan sayılır. Git yoksa/hata: çalışan değil. */
function inWorkerBranch(cwd: string): boolean {
  try { return /^vlad\/T\d{8}-\d+$/.test(execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim()); } catch { return false; }
}

/** Mod yazan komutların koruması: ortam değişkeni VE cwd dalı (çalışan oturumu mod açamaz/kapatamaz). */
export function assertNotWorker(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): void {
  assertNotWorkerEnv(env);
  if (inWorkerBranch(cwd)) throw new Error("çalışan oturumu mod yazamaz (cwd vlad/T… çalışan dalında); yetki penceresini yalnız VLAD/kullanıcı açar");
}
