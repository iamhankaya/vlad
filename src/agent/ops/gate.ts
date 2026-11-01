import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readDoc } from "../../kb/doc.js";
import { RemoteError, type GateRunResult, type MergePreviewResult, type MergeResult } from "../../machines/types.js";
import { entriesOf, readRecord, verifiedRecord } from "./launch.js";
import { argObject, bad, projectArg, repoNameArg, taskIdArg, workerCtx, workerKbDir, workerWorktree } from "./worker.js";
import type { WorkerCtx } from "./worker.js";

// Kapı op'ları (brain → worker; push YOK). Gate komutu, çalışma dizini ve dal adları işçinin kendi kb klonundan /
// başlatma kaydından türetilir; istekten yalnız kimlikler ve doğrulanan ref'ler alınır.

const GATE_TIMEOUT_MS = 25 * 60_000;
const OUT_CAP = 100 * 1024;
const MAX_MESSAGE = 1024;
const TASK_BRANCH = /^vlad\/T\d{8}-\d{2,}$/;
const DEFAULT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const forbidden = (m: string) => new RemoteError("forbidden", `forbidden: ${m}`);
const failed = (m: string) => new RemoteError("failed", `failed: ${m}`);

interface TaskFront { project: string; kind?: string; parent?: string | null; machine?: string | null }
interface TaskRef { id: string; parent?: string | null; defaultBranch?: string }

/** Merge ref'leri: kaynak görevin kendi dalı; hedef çatı entegrasyon dalı, çatı yoksa kartın ana dalı. */
export function checkMergeRefs(t: TaskRef, from: string, into: string): void {
  if (!TASK_BRANCH.test(from) || from !== `vlad/${t.id}`) throw bad("from görevin kendi dalı (vlad/<taskId>) olmalı");
  const ok = t.parent ? into === `vlad/${t.parent}` : !!t.defaultBranch && DEFAULT_BRANCH.test(t.defaultBranch) && !t.defaultBranch.includes("..") && into === t.defaultBranch;
  if (!ok) throw bad(t.parent ? "into çatı dalı (vlad/<çatı>) olmalı" : "into kartın default_branch'i olmalı");
}

/** Sondan kırp: kırmızı gate'in hatası genellikle çıktının sonundadır. */
export function capText(s: string, max: number): string {
  return s.length <= max ? s : `[…ilk ${s.length - max} karakter kırpıldı]\n${s.slice(s.length - max)}`;
}

/** `git merge-tree --write-tree --name-only` çıktısı: ilk satır ağaç kimliği, sonrası çakışan dosyalar. */
export const conflictsOf = (stdout: string): string[] => stdout.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);

function taskFront(ctx: WorkerCtx, id: string, project: string): TaskFront {
  const f = join(workerKbDir(ctx.def), "tasks", `${id}.md`);
  if (!existsSync(f)) throw new RemoteError("not_found", `not_found: görev dosyası işçi kb'sinde yok: ${id}`);
  const t = readDoc<TaskFront>(f).data;
  if (t.project !== project) throw bad("project görevin projesiyle uyuşmuyor");
  if (t.machine && t.machine !== ctx.self) throw forbidden(`görev başka makinede: ${t.machine}`);
  return t;
}
function defaultBranchOf(ctx: WorkerCtx, project: string): string | undefined {
  try { return readDoc<{ default_branch?: string }>(join(workerKbDir(ctx.def), "projects", `${project}.md`)).data.default_branch; } catch { return undefined; }
}
/** Entegrasyon worktree'si: çatının başlatma kaydındaki girdilerden biri olmalı (yol işçide hesaplanır). */
function integrationWorktree(ctx: WorkerCtx, repo: string, integId: string): string {
  const wt = workerWorktree(ctx, repo, integId);
  const rec = readRecord(integId);
  if (!rec || !entriesOf(rec).some((e) => e.repo === repo && e.worktree === wt)) throw forbidden(`entegrasyon kaydı yok: ${integId}`);
  if (!existsSync(wt)) throw new RemoteError("not_found", `not_found: entegrasyon worktree'si yok: ${wt}`);
  return wt;
}

interface Run { code: number | null; stdout: string; stderr: string }
function runGit(cwd: string, args: string[], timeoutMs = 120_000): Promise<Run> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : null) : 0, stdout, stderr }));
  });
}
async function mustGit(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.code !== 0) throw failed(`git ${args[0]} başarısız: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function gateRun(args: unknown): Promise<GateRunResult> {
  const a = argObject(args, ["taskId", "project", "repoName", "target"]);
  const id = taskIdArg(a);
  const project = projectArg(a);
  const repoName = repoNameArg(a);
  if (a.target !== "integration" && a.target !== "task") throw bad("target geçersiz");
  const ctx = workerCtx();
  const front = taskFront(ctx, id, project);
  const { repo, wt } = verifiedRecord(ctx, id, repoName);
  let cwd = wt;
  if (a.target === "integration") {
    const integ = front.parent ?? (front.kind === "pipeline" ? id : null);
    if (!integ) throw bad("görevin entegrasyon dalı yok (çatı/faz değil)");
    cwd = integrationWorktree(ctx, repo, integ);
  }
  if (!existsSync(cwd)) throw new RemoteError("not_found", `not_found: worktree yok: ${cwd}`);
  let gate: string | undefined;
  try { gate = readDoc<{ gate?: string }>(join(workerKbDir(ctx.def), "projects", `${project}.md`)).data.gate; } catch { /* kart yok → aşağıda */ }
  if (!gate?.trim()) throw failed(`projede gate tanımlı değil: ${project}`);
  return runGate(gate, cwd);
}

function runGate(cmd: string, cwd: string): Promise<GateRunResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, { cwd, shell: true, windowsHide: true });
    let stdout = "", stderr = "";
    const keep = (s: string, d: Buffer) => (s + d.toString("utf8")).slice(-2 * OUT_CAP); // bellek sınırı
    p.stdout.on("data", (d: Buffer) => { stdout = keep(stdout, d); });
    p.stderr.on("data", (d: Buffer) => { stderr = keep(stderr, d); });
    let timedOut = false;
    // shortcut: yalnız kabuk süreci öldürülür, torunlar kalabilir; gerçek süreç ağacı temizliği gerekirse taskkill /T ekle
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, GATE_TIMEOUT_MS);
    const done = (exit: number, extra = "") => { clearTimeout(timer); resolve({ exit, stdout: capText(stdout, OUT_CAP), stderr: capText(stderr + extra, OUT_CAP) }); };
    p.on("error", (e) => done(127, `\ngate başlatılamadı: ${e.message}`));
    p.on("close", (code) => done(timedOut ? 124 : (code ?? 1), timedOut ? "\ngate zaman aşımına uğradı" : ""));
  });
}

interface MergeCtx { repo: string; cwd: string; into: string; from: string }
function mergeCtx(args: unknown, extra: string[]): MergeCtx & { a: Record<string, unknown> } {
  const a = argObject(args, ["taskId", "project", "repoName", "from", "into", ...extra]);
  const id = taskIdArg(a);
  const project = projectArg(a);
  const repoName = repoNameArg(a);
  if (typeof a.from !== "string" || typeof a.into !== "string") throw bad("from/into zorunlu");
  const ctx = workerCtx();
  const front = taskFront(ctx, id, project);
  checkMergeRefs({ id, parent: front.parent, defaultBranch: defaultBranchOf(ctx, project) }, a.from, a.into);
  const { repo } = verifiedRecord(ctx, id, repoName);
  // faz → çatı dalı çatının worktree'sinde, son kapı → ana dal proje reposunda
  const cwd = front.parent ? integrationWorktree(ctx, repo, front.parent) : repo;
  return { repo, cwd, into: a.into, from: a.from, a };
}

export async function mergePreview(args: unknown): Promise<MergePreviewResult> {
  const { repo, into, from } = mergeCtx(args, []);
  for (const ref of [from, into]) if (!(await runGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`])).stdout.trim()) throw new RemoteError("not_found", `not_found: dal yok: ${ref}`);
  const log = await mustGit(repo, ["log", "--oneline", "-n", "200", `refs/heads/${into}..refs/heads/${from}`]);
  const diffStat = await mustGit(repo, ["diff", "--stat", `refs/heads/${into}...refs/heads/${from}`]);
  const mt = await runGit(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", `refs/heads/${into}`, `refs/heads/${from}`]);
  if (mt.code !== 0 && mt.code !== 1) throw failed(`git merge-tree başarısız: ${(mt.stderr || mt.stdout).trim()}`);
  return { log: capText(log, OUT_CAP), diffStat: capText(diffStat, OUT_CAP), conflicts: mt.code === 1 ? conflictsOf(mt.stdout) : [] };
}

let mergeChain: Promise<unknown> = Promise.resolve();
/** Aynı işçide merge'ler sırayla (aynı worktree'de iki merge çakışır). */
export function mergeOp(args: unknown): Promise<MergeResult> {
  const run = mergeChain.then(() => mergeOne(args));
  mergeChain = run.catch(() => undefined);
  return run;
}

async function mergeOne(args: unknown): Promise<MergeResult> {
  const { cwd, into, from, a } = mergeCtx(args, ["message"]);
  const message = a.message === undefined ? `Merge ${from}` : a.message;
  if (typeof message !== "string" || !message.trim() || message.includes("\0") || Buffer.byteLength(message) > MAX_MESSAGE) throw bad("message geçersiz");
  if (!existsSync(cwd)) throw new RemoteError("not_found", `not_found: worktree yok: ${cwd}`);
  const cur = (await runGit(cwd, ["branch", "--show-current"])).stdout.trim();
  if (cur !== into) throw failed(`${cwd} dizini ${into} dalında değil (${cur || "bilinmiyor"})`);
  if (!(await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${from}`])).stdout.trim()) throw new RemoteError("not_found", `not_found: dal yok: ${from}`);
  if ((await runGit(cwd, ["merge-base", "--is-ancestor", `refs/heads/${from}`, "HEAD"])).code === 0) {
    return { head: (await mustGit(cwd, ["rev-parse", "HEAD"])).trim(), merged: false }; // zaten içeride
  }
  const m = await runGit(cwd, ["merge", "--no-ff", "-m", message, `refs/heads/${from}`], 300_000);
  if (m.code !== 0) {
    await runGit(cwd, ["merge", "--abort"]);
    throw new RemoteError("conflict", `conflict: merge başarısız, geri alındı: ${(m.stdout + m.stderr).trim().slice(-2000)}`);
  }
  return { head: (await mustGit(cwd, ["rev-parse", "HEAD"])).trim(), merged: true };
}
