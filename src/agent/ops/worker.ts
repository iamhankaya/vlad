import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { loadConfig } from "../../kb/config.js";
import { kbPaths } from "../../kb/home.js";
import type { VladConfig } from "../../kb/types.js";
import { NoopLauncher, PosixLauncher, TerminalLauncher, resolveLaunchMode } from "../../launcher/index.js";
import type { Launcher } from "../../launcher/index.js";
import { machineDef } from "../../fleet/registry.js";
import { pickRepoDir } from "../../fleet/paths.js";
import { RemoteError, type MachineDef } from "../../fleet/types.js";
import { worktreePath } from "../../git/git.js";
import { selfName } from "../../fleet/state.js";

export const bad = (m: string) => new RemoteError("bad_request", `bad_request: ${m}`);
const TASK_ID = /^T\d{8}-\d{2,}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** İstek argümanını nesne olarak alır; bilinmeyen anahtar → bad_request (istekten yol/ek alan kabul edilmez). */
export function argObject(a: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!a || typeof a !== "object" || Array.isArray(a)) throw bad("argüman nesne olmalı");
  const o = a as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw bad(`bilinmeyen alan: ${extra.join(", ")}`);
  return o;
}
export function taskIdArg(o: Record<string, unknown>): string {
  if (typeof o.taskId !== "string" || !TASK_ID.test(o.taskId)) throw bad("taskId geçersiz");
  return o.taskId;
}
export function projectArg(o: Record<string, unknown>): string {
  if (typeof o.project !== "string" || !SLUG.test(o.project) || o.project.includes("..")) throw bad("project geçersiz");
  return o.project;
}
export function repoNameArg(o: Record<string, unknown>): string {
  if (typeof o.repoName !== "string" || !REPO_NAME.test(o.repoName) || o.repoName.includes("..")) throw bad("repoName geçersiz");
  return o.repoName;
}

export interface WorkerCtx { cfg: VladConfig; self: string; def: MachineDef }
/** Çalışan Agent'ın kendi config'i (her çağrıda taze) ve makine tanımı. */
export function workerCtx(): WorkerCtx {
  const cfg = loadConfig();
  const self = selfName();
  const def = machineDef(cfg, self);
  if (!def) throw new RemoteError("failed", `failed: bu makine config'te tanımlı değil: ${self}`);
  return { cfg, self, def };
}

/** İşçinin kb klonu: makinenin `kbDir`'i, yoksa normal çözüm. */
export const workerKbDir = (def: MachineDef): string => def.kbDir ?? kbPaths().kb;
export const taskFileOf = (def: MachineDef, id: string): string => join(workerKbDir(def), "tasks", `${id}.md`);

/** `<root>/<repoName>` ve `.git` taşıyan tek dizin; 0 → not_found "repo yok", >1 → conflict "belirsiz repo adı". */
export function resolveRepo(def: MachineDef, repoName: string): string {
  const found = (def.roots ?? []).map((r) => join(r, repoName)).filter((d) => existsSync(join(d, ".git"))).map((d) => realpathSync.native(d));
  const pick = pickRepoDir(found);
  if (pick.ok) return pick.dir;
  if (pick.code === "not_found") throw new RemoteError("not_found", `not_found: repo yok: ${repoName}`);
  throw new RemoteError("conflict", `conflict: belirsiz repo adı: ${repoName} (${pick.candidates.join(", ")})`);
}

/** Worktree yolu yalnız işçinin kendi config'inden hesaplanır (istekten yol alınmaz). */
export function workerWorktree(ctx: WorkerCtx, repo: string, id: string): string {
  return worktreePath({ ...ctx.cfg, worktreeDir: ctx.def.worktreeDir ?? ctx.cfg.worktreeDir }, repo, id, process.platform as "win32" | "darwin" | "linux");
}

/** `p` gerçek yol olarak `root`un altında mı (varsa; bağlantılar çözülür). */
export function isInside(root: string, p: string): boolean {
  try {
    const r = realpathSync(root), q = realpathSync(p);
    return q !== r && q.startsWith(r.endsWith(sep) ? r : r + sep);
  } catch { return false; }
}

/** `wt` gerçek yol olarak tam `<root>/<id>`: bir bağlantı (junction/symlink) onu kardeş görevin klasörüne çeviremez (F-vlad-133). */
export function isOwnWorktree(root: string, wt: string, id: string): boolean {
  try { return realpathSync(wt) === join(realpathSync(root), id); } catch { return false; }
}

/** cli.ts'teki başlatıcı seçiminin işçi karşılığı (noop koruması dâhil). */
export function workerLauncher(cfg: VladConfig): Launcher {
  const mode = resolveLaunchMode(cfg.launcher);
  if (mode === "cloud") throw new RemoteError("failed", "failed: işçi makinede bulut başlatıcı kullanılamaz");
  if (mode === "noop") return new NoopLauncher();
  if (mode === "tmux" || mode === "terminal") return new PosixLauncher({ mode, dryRun: false });
  return new TerminalLauncher({ mode: mode === "wt" || mode === "powershell" ? mode : "auto" });
}
