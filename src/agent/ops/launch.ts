import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { branchExistsAsync, runGitAsync, runGitRawAsync } from "../../git/git-async.js";
import { getVladHome } from "../../kb/home.js";
import { fillRolePlaceholders } from "../../roles/store.js";
import { writeFileAtomic } from "../../kb/atomic.js";
import { closeWorkerWindow, resolveLaunchMode } from "../../launcher/index.js";
import type { Launcher } from "../../launcher/index.js";
import { RemoteError } from "../../machines/types.js";
import { ASYNC_GIT, ensureIntegrationGitWith, launchCore } from "../../tasks/launch-core.js";
import { removeTaskWorktree } from "../../tasks/launch.js";
import { dirtyLine } from "../../tasks/resume.js";
import { untrustWorktree } from "../../tasks/trust.js";
import type { Reconciler } from "../reconcile.js";
import { agentDir } from "../state.js";
import { argObject, bad, isOwnWorktree, projectArg, repoNameArg, resolveRepo, taskFileOf, taskIdArg, workerCtx, workerLauncher, workerWorktree } from "./worker.js";
import type { WorkerCtx } from "./worker.js";

export interface LaunchResultW { branch: string; worktree: string; method: string; integration?: { branch: string; worktree: string } }
interface RecEntry { repo: string; worktree: string; branch: string }
interface LaunchRecord extends RecEntry { taskId: string; opId: string | null; /** set once the launch finished; a record without it is a launch that started and may or may not have opened a window */ result?: LaunchResultW; /** a pipeline parent's integration worktrees in further repos */ extra?: RecEntry[] }
type CloseFn = (id: string) => number[] | void;

const MAX_TEXT = 256 * 1024;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/;
const COMPACT = /^\d+(\.\d+)?[kKmM]?$/;
const failed = (m: string) => new RemoteError("failed", `failed: ${m}`);
const forbidden = (m: string) => new RemoteError("forbidden", `forbidden: ${m}`);

/** İşçinin pencere kapatıcısı: noop korumasında hiç pencere açılmadığından kapatılacak da yoktur (gerçek süreç öldürülmez). */
const defaultClose: CloseFn = (id) => (resolveLaunchMode(workerCtx().cfg.launcher) === "noop" ? [] : closeWorkerWindow(id));

const launchesDir = () => join(agentDir(), "launches");
const recordFile = (id: string) => join(launchesDir(), `${id}.json`);
export function readRecord(id: string): LaunchRecord | null {
  try { return JSON.parse(readFileSync(recordFile(id), "utf8")) as LaunchRecord; } catch { return null; }
}
function writeRecord(r: LaunchRecord): void {
  mkdirSync(launchesDir(), { recursive: true });
  writeFileAtomic(recordFile(r.taskId), JSON.stringify(r, null, 2) + "\n");
}

function text(o: Record<string, unknown>, k: string, max: number): string {
  const v = o[k];
  if (typeof v !== "string" || !v || v.includes("\0") || Buffer.byteLength(v) > max) throw bad(`${k} geçersiz`);
  return v;
}
function optStr(o: Record<string, unknown>, k: string, re: RegExp): string | undefined {
  if (o[k] === undefined) return undefined;
  if (typeof o[k] !== "string" || !re.test(o[k] as string)) throw bad(`${k} geçersiz`);
  return o[k] as string;
}

/** Kayıt, işçinin kendi hesapladığı yolla birebir eşit olmalı; aksi forbidden (istekten yol alınmaz). */
export function verifiedRecord(ctx: WorkerCtx, id: string, repoName: string): { repo: string; wt: string } {
  const rec = readRecord(id);
  if (!rec) throw forbidden(`başlatma kaydı yok: ${id}`);
  const repo = resolveRepo(ctx.def, repoName);
  const wt = workerWorktree(ctx, repo, id);
  if (rec.taskId !== id || !entriesOf(rec).some((e) => e.worktree === wt && e.repo === repo)) throw forbidden("başlatma kaydı hesaplanan yolla uyuşmuyor");
  return { repo, wt };
}
export const entriesOf = (r: LaunchRecord): RecEntry[] => [{ repo: r.repo, worktree: r.worktree, branch: r.branch }, ...(r.extra ?? [])];
/** Removes the entry of a cleaned worktree; the record file goes when nothing is left. */
function dropEntry(id: string, repo: string, wt: string): void {
  const rec = readRecord(id);
  if (!rec) return;
  const rest = entriesOf(rec).filter((e) => !(e.repo === repo && e.worktree === wt));
  if (!rest.length) { rmSync(recordFile(id), { force: true }); return; }
  const [first, ...extra] = rest;
  writeRecord({ ...rec, ...first!, extra });
}

const fill = (s: string, ctx: WorkerCtx, id: string): string => fillRolePlaceholders(s.split("{{TASK_FILE}}").join(taskFileOf(ctx.def, id)), getVladHome());
// işçinin kbDir'i oturuma da geçer: yoksa `vlad kb get`/`task list` yanlış kb'yi okur (F-vlad-147)
const envOf = (id: string, ctx: WorkerCtx) => ({ VLAD_TASK_ID: id, VLAD_HOME: getVladHome(), ...(ctx.def.kbDir ? { VLAD_KB_DIR: ctx.def.kbDir } : {}) });

let launchChain: Promise<unknown> = Promise.resolve();
/** Async git removed the accidental serialisation sync calls gave: launches on one worker run one at a time again (worktree/branch/lock races). */
export function launchOp(args: unknown, c: { from: string; opId: string }, o: { launcher?: Launcher } = {}): Promise<LaunchResultW> {
  const run = launchChain.then(() => launchOne(args, c, o));
  launchChain = run.catch(() => undefined);
  return run;
}

async function launchOne(args: unknown, c: { from: string; opId: string }, o: { launcher?: Launcher }): Promise<LaunchResultW> {
  const a = argObject(args, ["taskId", "project", "repoName", "branch", "base", "promptTemplate", "title", "model", "autoCompact"]);
  const id = taskIdArg(a);
  projectArg(a);
  const repoName = repoNameArg(a);
  if (a.branch !== `vlad/${id}`) throw bad("branch vlad/<taskId> olmalı");
  const b = a.base as Record<string, unknown> | undefined;
  if (!b || typeof b !== "object" || (b.kind !== "default" && b.kind !== "integration")) throw bad("base geçersiz");
  const defaultBranch = optStr(b, "defaultBranch", REF);
  const parent = b.kind === "integration" ? taskIdArg({ taskId: b.parent }) : undefined;
  const template = text(a, "promptTemplate", MAX_TEXT);
  const title = text(a, "title", 300);
  const model = optStr(a, "model", MODEL);
  const autoCompact = optStr(a, "autoCompact", COMPACT);

  const ctx = workerCtx();
  const existing = readRecord(id);
  if (existing && existing.opId !== c.opId) throw new RemoteError("conflict", `conflict: görev bu makinede zaten başlatılmış (op ${existing.opId ?? "?"})`);
  const repo = resolveRepo(ctx.def, repoName);
  const worktree = workerWorktree(ctx, repo, id);
  const launcher = o.launcher ?? workerLauncher(ctx.cfg);
  const wcfg = { ...ctx.cfg, worktreeDir: ctx.def.worktreeDir ?? ctx.cfg.worktreeDir };
  if (existing?.result) return existing.result; // same opId replayed after the launch finished
  if (existing) throw new RemoteError("conflict", `conflict: bu launch (op ${c.opId}) yarım kaldı; pencere açılmış olabilir, kontrol et`);
  // The record goes down BEFORE anything opens: a crash after the window opened still leaves proof the launch started,
  // so reconcile reports it uncertain instead of letting a retry open a second window.
  writeRecord({ taskId: id, repo, worktree, branch: `vlad/${id}`, opId: c.opId });
  let integration: { branch: string; worktree: string } | undefined;
  let res;
  try {
    if (parent) integration = await ensureIntegrationGitWith(ASYNC_GIT, repo, parent, wcfg, defaultBranch);
    res = await launchCore({
      taskId: id, repo, worktree, branch: `vlad/${id}`,
      ...(integration ? { base: integration.branch } : defaultBranch && (await branchExistsAsync(repo, defaultBranch)) ? { base: defaultBranch } : {}),
      prompt: fill(template, ctx, id), env: envOf(id, ctx), title,
      ...(model ? { model } : {}), ...(autoCompact ? { autoCompact } : {}),
    }, launcher, ASYNC_GIT);
  } catch (e) {
    rmSync(recordFile(id), { force: true }); // launchCore undid its own work: nothing is running, a retry starts clean
    throw failed((e as Error).message);
  }
  const result: LaunchResultW = { branch: res.branch, worktree: res.worktree, method: res.method, ...(integration ? { integration } : {}) };
  writeRecord({ taskId: id, repo, worktree, branch: res.branch, opId: c.opId, result });
  if (parent && integration) {
    const pr = readRecord(parent);
    const entry = { repo, worktree: integration.worktree, branch: integration.branch };
    if (!pr) writeRecord({ taskId: parent, ...entry, opId: null });
    else if (!entriesOf(pr).some((e) => e.repo === repo && e.worktree === entry.worktree)) writeRecord({ ...pr, extra: [...(pr.extra ?? []), entry] });
  }
  return result;
}

/** Açılış uzlaştırması: sonuçlu kayıt → uygulandı (sonucuyla); sonuçsuz kayıt → başladı ama bitişi bilinmiyor (pencere açılmış olabilir: uncertain); kayıt yok → güvenle yeniden denenebilir. */
export const reconcileLaunch: Reconciler = (rec) => {
  const dir = launchesDir();
  if (!existsSync(dir)) return "not-applied";
  for (const f of readdirSync(dir)) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as LaunchRecord;
      if (r.opId === rec.opId) return r.result ? { verdict: "applied", result: r.result } : "unknown";
    } catch { /* bozuk kayıt: atla */ }
  }
  return "not-applied";
};

export async function closeOp(args: unknown, o: { close?: CloseFn } = {}): Promise<{ killed: number[] }> {
  const id = taskIdArg(argObject(args, ["taskId"]));
  try { return { killed: (o.close ?? defaultClose)(id) ?? [] }; } catch (e) { throw failed((e as Error).message); }
}

export async function cleanupOp(args: unknown, o: { close?: CloseFn } = {}): Promise<{ removed: boolean }> {
  const a = argObject(args, ["taskId", "project", "repoName", "terminal"]);
  const id = taskIdArg(a);
  projectArg(a);
  const repoName = repoNameArg(a);
  if (a.terminal !== true) throw forbidden("cleanup yalnız done/cancelled görev için (terminal:true)");
  const ctx = workerCtx();
  const { repo, wt } = verifiedRecord(ctx, id, repoName);
  if (!existsSync(wt)) { dropEntry(id, repo, wt); return { removed: false }; }
  if (!isOwnWorktree(dirname(workerWorktree(ctx, repo, id)), wt, id)) throw forbidden(`worktree kendi görev klasörü değil / kök dışında: ${wt}`); // kök config'ten, wt'den değil (F-vlad-133)
  try { (o.close ?? defaultClose)(id); } catch { /* kapatılamayan pencere silme adımında raporlanır */ }
  let warn: string | null = null;
  try { warn = untrustWorktree(wt); } catch (e) { warn = (e as Error).message; }
  if (warn) throw failed(`güven kaydı kaldırılamadı, worktree silinmedi: ${warn}`); // fail-closed
  if (!isOwnWorktree(dirname(workerWorktree(ctx, repo, id)), wt, id)) throw forbidden(`worktree silmeden hemen önce kök denetimi başarısız: ${wt}`); // pencere kapatma/güven adımları sırasında yol değişmiş olabilir (F-vlad-154)
  try { removeTaskWorktree(repo, wt, id); } catch (e) { throw failed((e as Error).message); }
  dropEntry(id, repo, wt);
  return { removed: true };
}

export async function resumeOp(args: unknown, o: { launcher?: Launcher; close?: CloseFn } = {}): Promise<{ worktree: string; method: string; dirty: string[] }> {
  const a = argObject(args, ["taskId", "project", "repoName", "promptTemplate", "title", "model", "autoCompact", "sessionId"]);
  const id = taskIdArg(a);
  projectArg(a);
  const repoName = repoNameArg(a);
  const template = text(a, "promptTemplate", MAX_TEXT);
  const title = text(a, "title", 300);
  const model = optStr(a, "model", MODEL);
  const autoCompact = optStr(a, "autoCompact", COMPACT);
  const sessionId = optStr(a, "sessionId", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  const ctx = workerCtx();
  const { wt } = verifiedRecord(ctx, id, repoName);
  if (!existsSync(wt)) throw new RemoteError("not_found", `not_found: worktree yok: ${wt}; görev ${id} bu makinede sürdürülemez`);
  const cur = (await runGitAsync(wt, ["branch", "--show-current"])) || null;
  if (cur !== `vlad/${id}`) throw failed(`worktree yanlış branch'te (${cur ?? "bilinmiyor"}, beklenen vlad/${id}): ${wt}`);
  const dirty = ((await runGitRawAsync(wt, ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"], 30_000)) ?? "")
    .split("\n").filter((l) => l.length >= 4).map((l) => l.slice(3));
  const prompt = fill(template, ctx, id).split("{{WORKTREE}}").join(wt).split("{{DIRTY_LINE}}").join(dirtyLine(dirty));
  const launcher = o.launcher ?? workerLauncher(ctx.cfg);
  try { (o.close ?? defaultClose)(id); } catch { /* no window to close, or it could not be closed: the launcher reports real failures */ } // no second window beside a live one
  let r;
  try {
    r = await launcher.launch({ taskId: id, cwd: wt, prompt, env: envOf(id, ctx), title, ...(model ? { model } : {}), ...(autoCompact ? { autoCompact } : {}), resume: { sessionId } });
  } catch (e) { throw failed(`launcher başarısız: ${(e as Error).message}`); }
  if (!r.ok) throw failed(`launcher başarısız (${r.method}): ${r.detail ?? "bilinmeyen hata"}`);
  return { worktree: wt, method: r.method, dirty };
}
