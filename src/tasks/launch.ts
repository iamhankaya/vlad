import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  isWorktree, ReparseCleanupError, removeWorktree, runGit,
  unlinkReparsePoints, worktreePath,
} from "../git/git.js";
import { readDoc, kbPaths, withKbLock } from "../kb/index.js";
import type { ProjectCard, TaskState, VladConfig } from "../kb/index.js";
import { countOpenSevere } from "../findings/store.js";
import { countInbox } from "../inbox/inbox.js";
import { closeWorkerWindow } from "../launcher/index.js";
import type { Launcher } from "../launcher/index.js";
import { splitSkills } from "../roles/store.js";
import type { Role } from "../roles/store.js";
import { applyRemoteStalls, markSilentWorkers } from "./liveness.js";
import type { LivenessProbe, RemoteStallPlan } from "./liveness.js";
import {
  effectiveModel, getTask, listTasks, markStale, roleFor, saveTask, setState, syncAutonomy, unmetDependencies,
} from "./store.js";
import type { Task } from "./store.js";
import { BLOCKS_HEADING, standardBlocks } from "./blocks.js";
import type { BlockCtx } from "./blocks.js";
import { expireMode, modeLine } from "../mode/store.js";
import { untrustWorktree } from "./trust.js";
import { ensureIntegrationGit, launchCore } from "./launch-core.js";
import { nowMs } from "../machines/clock.js";
import { capsOf, machineLoad, pickMachine } from "../machines/placement.js";
import { machinesOf } from "../machines/registry.js";
import { repoNameOf } from "../machines/paths.js";
import { RemoteError } from "../machines/types.js";
import type { AgentCode, RemoteTransport } from "../machines/types.js";

const ALL_STATES: TaskState[] = [
  "queued", "running", "blocked", "stalled", "awaiting_approval", "done", "failed", "cancelled",
];
const ACTIVE: TaskState[] = ["running", "blocked", "stalled", "awaiting_approval"];

function projectCard(slug: string): ProjectCard {
  const file = join(kbPaths().projects, `${slug}.md`);
  if (!existsSync(file)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  return readDoc<ProjectCard>(file).data;
}

const projectPath = (slug: string): string => projectCard(slug).path;
const projectDefaultBranch = (slug: string): string | undefined => projectCard(slug).default_branch ?? undefined;

/** Persists the last error on a task without touching its state. */
const recordError = (id: string, msg: string): Promise<void> => withKbLock(() => {
  const t = getTask(id);
  if (t.data.state === "running") return; // started elsewhere while the launcher ran: the error field is not ours to set (F-vlad-102)
  t.data.error = msg;
  saveTask(t);
});

export function buildPrompt(
  taskFile: string, autonomy: string, role?: { title: string; file: string; skills?: string[] },
  ctx?: { taskId: string; parent: string | null; projectSkills?: string[] },
  portable = false,
): string {
  const core = promptCore(taskFile, autonomy, role, portable);
  if (!ctx) return core;
  const blocks = standardBlocks({ taskId: ctx.taskId, autonomy: autonomy as BlockCtx["autonomy"], parent: ctx.parent, mode: "local", projectSkills: ctx.projectSkills });
  return [core, BLOCKS_HEADING, ...blocks].join("\n\n");
}

/**
 * `portable` (uzak işçi): rol dosyası ve vendored skill yolları beynin yerel yolları olamaz (Mac yolu Windows'ta yok);
 * `{{ROLE_FILE:<slug>}}` / `{{VENDOR_SKILL:<ad>}}` bırakılır, işçi kendi VLAD_HOME'una göre doldurur.
 */
function promptCore(taskFile: string, autonomy: string, role?: { title: string; file: string; skills?: string[]; slug?: string }, portable = false): string {
  const base =
    `Sen bir VLAD çalışanısın. Görevin: \`${taskFile}\`. ` +
    `Önce \`vlad-worker\` skill'ini yükle ve protokolünü uygula. Yetki seviyen: \`${autonomy}\`.`;
  if (!role) return base;
  const withRole =
    `${base} Rolün: ${role.title}. Göreve başlamadan önce \`${portable ? `{{ROLE_FILE:${slugOf(role.file)}}}` : role.file}\` dosyasını oku ` +
    `ve oradaki sorumluluk, yetki ve çıktı kurallarına uy.`;
  const { load, vendored } = splitSkills(role.skills ?? [], role.file);
  const parts = [withRole];
  if (load.length) {
    parts.push(`İşe başlamadan şu skill'leri yükle: ${load.map((s) => `\`${s}\``).join(", ")}. Yüklenemeyen olursa kapanış raporunda belirt.`);
  }
  for (const v of vendored) parts.push(`\`${v.name}\` skill'i yüklü değildir; \`${portable ? `{{VENDOR_SKILL:${v.name}}}` : v.file}\` dosyasını oku ve uygula.`);
  return parts.join(" ");
}

const slugOf = (file: string): string => basename(file).replace(/\.md$/, "");

const CLOSED: TaskState[] = ["done", "cancelled", "failed"];

/**
 * Pipeline spec §6: makes sure the integration branch `vlad/<parent>` and its worktree exist in the
 * repo of `project` (the phase's project; default: the pipeline's own). A missing local branch is
 * tracked from `origin/vlad/<parent>` if that exists, else cut from the card's default branch (HEAD
 * when unset). Only a phase of the pipeline's own project records branch/worktree on the pipeline
 * task: in another project's repo the worktree path is derived (`worktreePath(cfg, repo, parent)`).
 * The pipeline itself moves to `running` only when its phase does (setState), so a failed launch
 * leaves it queued.
 */
export function ensureIntegration(
  parentId: string, cfg: VladConfig, project?: string,
): { repo: string; branch: string; worktree: string } {
  const p = getTask(parentId);
  if (CLOSED.includes(p.data.state)) throw new Error(`çatı görev ${parentId} ${p.data.state}; fazı başlatılamaz`);
  const slug = project ?? p.data.project;
  const repo = projectPath(slug);
  const { branch, worktree } = ensureIntegrationGit(repo, parentId, cfg, projectDefaultBranch(slug));
  recordIntegration(parentId, slug, branch, worktree);
  return { repo, branch, worktree };
}

/** kb half of `ensureIntegration`: only a phase of the pipeline's own project records branch/worktree on the pipeline task. */
export function recordIntegration(parentId: string, project: string, branch: string, worktree: string): void {
  const p = getTask(parentId);
  if (project === p.data.project && (p.data.branch !== branch || p.data.worktree !== worktree)) {
    Object.assign(p.data, { branch, worktree });
    saveTask(p);
  }
}

/**
 * F-vlad-063: the integration worktrees of a pipeline, one per project its phases run in (plus the
 * pipeline's own). Derived, not recorded: the pipeline task's `worktree` only covers its own project.
 */
export function integrationWorktrees(
  parentId: string, cfg: VladConfig, all?: Task[],
): { project: string; repo: string; branch: string; worktree: string }[] {
  // `all`: tasks the caller already loaded (task list), so N pipelines do not re-read the whole kb N times (F-vlad-094)
  const parent = all?.find((t) => t.data.id === parentId) ?? getTask(parentId);
  const projects = new Set([parent.data.project]);
  for (const c of all ? all.filter((t) => t.data.parent === parentId) : listTasks({ parent: parentId })) projects.add(c.data.project);
  const branch = `vlad/${parentId}`;
  const out: { project: string; repo: string; branch: string; worktree: string }[] = [];
  for (const project of projects) {
    // a phase project whose card is gone must not block listing or cleanup of the rest
    if (!existsSync(join(kbPaths().projects, `${project}.md`))) continue;
    const repo = projectPath(project);
    const worktree = worktreePath(cfg, repo, parentId, process.platform as "win32" | "darwin" | "linux");
    if (!out.some((w) => w.worktree === worktree)) out.push({ project, repo, branch, worktree });
  }
  return out;
}

/** Remote half of a launch (machines C1/C2): the transport to the worker Agent and an optional kb-sync step run before `launch`. */
export interface RemoteDeps {
  transport: RemoteTransport;
  /** Called (outside the kb lock) before the remote `launch`; throw to refuse (e.g. kb not pushed). */
  syncKb?: (machine: string) => Promise<void>;
}

/** A remote launch whose outcome is unknown keeps its reservation; anything else is a definite failure. */
const RETRY_STATES: ReadonlySet<string> = new Set(["unknown", "aborted", "cancelled", "aborted-cancelled", "failed", "not_found"]);
const UNCERTAIN: ReadonlySet<AgentCode> = new Set<AgentCode>(["unreachable", "timeout", "uncertain"]);

export interface LaunchOpts {
  launcher: Launcher; cfg: VladConfig; now?: Date; branchOf?: (worktree: string) => string | null;
  /** machines only: transport to the worker Agents */
  remote?: RemoteDeps;
  /** machines only: pin the task to one of its card's machines */
  machine?: string;
  /** CLI bayrakları: uzak makinede anlamsız, açık hata verir (yok sayılıp gerçek pencere açılmasın) */
  external?: boolean; dryRun?: boolean;
  /** test seam: closes the worker window when a launch is rolled back after the launcher ran (default: closeWorkerWindow) */
  closeWorker?: (taskId: string) => number[] | void;
}

/**
 * Opens worktree + branch, starts the launcher and moves the task to `running`. With `machines` in the
 * config the task is placed first (card order, capacity, reachability); a worker machine runs the launch
 * in three phases: reserve (kb lock) -> remote op (no lock) -> verify + write (kb lock). The brain launches locally.
 */
export async function launchTask(id: string, o: LaunchOpts): Promise<Task> {
  const task = getTask(id);
  if (task.data.state !== "queued") throw new Error(`görev queued değil (${task.data.state}): ${id}`);
  if (task.data.kind !== "dev") throw new Error(`yalnızca dev görevleri başlatılır (kind=${task.data.kind}): ${id}`);
  const unmet = unmetDependencies(task);
  if (unmet.length) throw new Error(`bağımlılıklar tamamlanmadı: ${unmet.join(",")}`);

  const stale = await withKbLock(() => syncAutonomy(task, o.cfg));
  if (stale) console.error(`uyarı: ${id} yetkisi config'ten güncellendi (${stale} → ${task.data.autonomy})`);

  if (!o.cfg.machines) {
    if (o.machine) throw new Error("--machine yalnız config'te machines tanımlıyken kullanılır");
    return launchLocal(task, o, {});
  }
  const machine = await placeTask(task, o);
  if (machine === o.cfg.brain) return launchLocal(task, o, { machine });
  if (o.external || o.dryRun) throw new Error(`${o.external ? "--external" : "--dry-run"} uzak makinede desteklenmez (görev ${machine} makinesine yerleşti); yerelde çalıştırmak için kartın makinelerini ya da --machine ${o.cfg.brain} kullan`);
  if (!o.remote) throw new Error(`uzak taşıma bağlı değil (VLAD Agent istemcisi yok): ${machine}`);
  return launchRemote(task, o, machine, o.remote);
}

/** Picks the machine: an existing (uncertain) reservation wins, else card order -> pipeline pin -> capacity -> reachability. */
async function placeTask(task: Task, o: LaunchOpts): Promise<string> {
  const { cfg } = o;
  const brain = cfg.brain!;
  if (task.data.machine && task.data.launch_op) return task.data.machine;
  const { names } = machinesOf(cfg, projectCard(task.data.project));
  const pin = task.data.parent ? getTask(task.data.parent).data.machine ?? undefined : undefined;
  if (o.machine && !names.includes(o.machine)) throw new Error(`--machine kart listesinde yok: ${o.machine}`);
  if (o.machine && pin && o.machine !== pin) throw new Error(`pipeline makinesi ${pin}; --machine ${o.machine} olamaz`);
  let cands = o.machine ? [o.machine] : names;
  if (pin) cands = cands.filter((n) => n === pin);
  const { load } = machineLoad(listTasks(), brain, nowMs());
  const transport = o.remote?.transport;
  const reach = transport
    ? async (m: string) => m === brain || await transport.call(m, "ping", {}).then(() => true, () => false)
    : undefined;
  const pick = await pickMachine(cands, load, capsOf(cfg), reach);
  if (pick.machine === null) {
    const why = pick.reasons.length ? pick.reasons.map((r) => `${r.machine}: ${r.reason}`).join(", ") : `${pin ?? "uygun makine"}: tanımsız`;
    throw new Error(`bekliyor — ${task.data.id} için makine yok (${why})`);
  }
  return pick.machine;
}

/** Records the error and, when the reservation is still ours (`launch_op`), releases it. */
const failReservation = (id: string, opId: string, msg: string, releaseMachinePin = false): Promise<void> => withKbLock(() => {
  const t = getTask(id);
  if (t.data.state === "running" || t.data.launch_op !== opId) return; // a newer attempt owns the task: a late reply writes nothing
  t.data.error = msg;
  const was = t.data.machine;
  Object.assign(t.data, { machine: null, machine_reserved: null, launch_op: null });
  saveTask(t);
  if (was && releaseMachinePin) releasePin(t.data.parent, was, id); // yalnız bu deneme koyduysa: önceki fazların pin'i kalır
});

/**
 * Kb kilidi altında çağrılır. Sabitlenmemiş pipeline'ın ilk rezervasyonu çatıyı hemen sabitler: eşzamanlı ikinci faz
 * pin'i görüp başka makineye kayamaz. Pin'i bu çağrı koyduysa true döner (hata yolunda `releasePin` ile geri alınır).
 */
function claimPin(parentId: string | null | undefined, machine: string): boolean {
  if (!parentId) return false;
  const p = getTask(parentId);
  if (p.data.machine) return false;
  p.data.machine = machine;
  saveTask(p);
  return true;
}

/** Pin'i bu rezervasyon koymuştu ve çatıda o makinede başka çalışan/rezerve faz yoksa kaldırır (kb kilidi altında). */
function releasePin(parentId: string | null | undefined, machine: string, selfId: string): void {
  if (!parentId) return;
  const p = getTask(parentId);
  if (p.data.machine !== machine) return;
  const busy = listTasks({ parent: parentId }).some((x) => x.data.id !== selfId && x.data.machine === machine && (x.data.launch_op || ["running", "blocked", "stalled", "awaiting_approval", "done"].includes(x.data.state)));
  if (busy) return;
  p.data.machine = null;
  saveTask(p);
}

/** The first phase of a pipeline pins the pipeline to its machine; later phases only go there. */
function pinPipeline(parentId: string | null | undefined, machine: string): void {
  if (!parentId) return;
  const p = getTask(parentId);
  if (p.data.machine) return;
  p.data.machine = machine;
  saveTask(p);
}

async function launchLocal(task: Task, o: LaunchOpts, patch: { machine?: string }): Promise<Task> {
  const { cfg } = o;
  const id = task.data.id;
  const branch = `vlad/${id}`;
  let repo: string;
  let wt: string;
  let role: Role | undefined;
  let base: string | undefined;
  try {
    if (task.data.role) role = roleFor(task.data.role, task.data.kind);
    repo = projectPath(task.data.project);
    wt = worktreePath(cfg, repo, id, process.platform as "win32" | "darwin" | "linux");
    // a pipeline phase branches from the pipeline's integration branch; the rollback in launchCore leaves it alone
    base = task.data.parent ? (await withKbLock(() => ensureIntegration(task.data.parent!, cfg, task.data.project))).branch : undefined;
  } catch (e) {
    const msg = (e as Error).message;
    await recordError(id, msg);
    throw new Error(msg);
  }
  const model = effectiveModel(task.data, role);
  const autoCompact = cfg.workerAutoCompact;
  // yerel (brain) yerleşim de kapasiteyi kilit altında ayırır (placeTask'ın kontrolü kilitsizdi: eşzamanlı iki launch ikisi de açılırdı)
  // ve çatıyı pencere açılmadan önce sabitler: eşzamanlı uzak kardeş faz başka makineye kayamaz
  const parent = task.data.parent;
  const opId = randomUUID();
  let claimed = false;
  if (patch.machine) {
    const m = patch.machine;
    claimed = await withKbLock(() => {
      const t = getTask(id);
      if (t.data.state !== "queued") throw new LostRace(`başka deneme kazandı (${id} artık queued değil); başlatılmadı`);
      const pin = parent ? getTask(parent).data.machine : null;
      if (pin && pin !== m) throw new Error(`pipeline ${pin} makinesine sabit; ${m} olamaz`);
      const { load } = machineLoad(listTasks().filter((x) => x.data.id !== id), cfg.brain!, nowMs());
      const cap = capsOf(cfg)[m];
      if (cap !== undefined && (load[m] ?? 0) >= cap) throw new Error(`bekliyor — ${id} için makine yok (${m}: dolu)`);
      Object.assign(t.data, { machine: m, machine_reserved: new Date(nowMs()).toISOString(), launch_op: opId });
      saveTask(t);
      return claimPin(parent, m);
    });
  }
  /** Hata yolu: rezervasyon hâlâ bizimse bırakılır (kb kilidi altında); pin'i yalnız bu deneme koyduysa geri alınır. */
  const unclaim = async (): Promise<void> => {
    if (!patch.machine) return;
    await withKbLock(() => {
      const t = getTask(id);
      if (t.data.state === "queued" && t.data.launch_op === opId) { Object.assign(t.data, { machine: null, machine_reserved: null, launch_op: null }); saveTask(t); }
      if (claimed) releasePin(parent, patch.machine!, id);
    });
  };
  try {
    await launchCore({
      taskId: id, repo, worktree: wt, branch, ...(base ? { base } : {}), ...(o.branchOf ? { branchOf: o.branchOf } : {}),
      prompt: buildPrompt(task.file, task.data.autonomy, role, { taskId: id, parent: task.data.parent ?? null, projectSkills: projectCard(task.data.project).skills }),
      env: { VLAD_TASK_ID: id, VLAD_HOME: kbPaths().home },
      title: `VLAD ${id} — ${task.data.title}`,
      ...(model ? { model } : {}),
      ...(autoCompact ? { autoCompact } : {}),
    }, o.launcher);
  } catch (e) {
    const msg = (e as Error).message;
    try { await unclaim(); } catch { /* best effort: asıl hata kaybolmasın */ }
    await recordError(id, msg);
    throw new Error(msg);
  }
  try {
    return await withKbLock(() => {
      const t = setState(id, "running", { branch, worktree: wt, error: null, ...patch, ...(patch.machine ? { machine_reserved: null, launch_op: null } : {}) });
      if (patch.machine) pinPipeline(t.data.parent, patch.machine);
      return t;
    });
  } catch (e) {
    // F-vlad-109: the task was cancelled/failed/done while the launcher ran: nothing may keep running for it
    const now = (() => { try { return getTask(id).data.state; } catch { return null; } })();
    if (now === "cancelled" || now === "failed" || now === "done") { // yalnız terminal: blocked/stalled canlı görevin worktree'ine dokunulmaz
      const problems: string[] = [];
      try { (o.closeWorker ?? closeWorkerWindow)(id); } catch (x) { problems.push(`pencere kapatılamadı: ${(x as Error).message}`); }
      try { removeTaskWorktree(repo, wt, id); } catch (x) { problems.push(`worktree kaldırılamadı: ${(x as Error).message}`); }
      try { untrustWorktree(wt); } catch { /* best effort */ }
      throw new Error(`görev başlatılırken ${now} yapıldı; açılan pencere kapatıldı, worktree kaldırıldı${problems.length ? ` (${problems.join("; ")}; elle temizle: ${wt})` : ""}`);
    }
    const msg = `terminal açıldı ama durum güncellenemedi: ${(e as Error).message}; worktree: ${wt}`;
    try { await recordError(id, msg); } catch { /* best effort */ }
    throw new Error(msg);
  }
}

/**
 * F-vlad-125/142: frees the reservation of a queued task whose remote launch outcome is unknown (dead machine, expired
 * reservation) and the pipeline pin it set. The worker is asked first (`op-status` with cancel: an unseen op gets a
 * tombstone and can never start); a finished or running launch is refused. `force` skips an unreachable worker: if it
 * did launch, its window and worktree stay orphaned there.
 */
export async function releaseTask(id: string, o: { cfg: VladConfig; transport?: RemoteTransport; force?: boolean }): Promise<Task> {
  const t0 = getTask(id);
  const machine = t0.data.machine, op = t0.data.launch_op;
  if (t0.data.state !== "queued" || !machine || !op) throw new Error(`serbest bırakılacak rezervasyon yok (${id}: ${t0.data.state}, makine ${machine ?? "-"})`);
  // beyin-yerel launch'ın rezervasyonu (launcher beklerken yazılır) beynin günlüğünde yoktur: iptal protokolü onu
  // "görülmemiş" sayıp çalışan bir launch'ın rezervasyonunu ve pin'ini silerdi
  if (o.cfg.brain && machine === o.cfg.brain) throw new Error(`rezervasyon beyin-yerel launch'a ait (${machine}); sürüyor olabilir, serbest bırakılamaz; ölüyse rezervasyon süresi dolunca kendiliğinden düşer`);
  let verdict: string | null = null;
  try {
    if (!o.transport) throw new Error("uzak taşıma bağlı değil");
    verdict = (await o.transport.call<OpStatus>(machine, "op-status", { target: op, cancel: true })).result.state;
  } catch (e) {
    if (!o.force) throw new Error(`${machine} makinesine ulaşılamadı (${(e as Error).message}); makine kalıcı ölüyse --force ile bırak (launch açılmışsa orada yetim kalır)`);
  }
  if (verdict === "done") throw new Error(`işçide launch tamamlanmış (op ${op}); serbest bırakma yerine \`task launch ${id}\` ile sahiplen`);
  if (verdict === "started") throw new Error(`işçide launch sürüyor (op ${op}); bitince tekrar dene`);
  return withKbLock(() => {
    const t = getTask(id);
    if (t.data.state !== "queued" || t.data.launch_op !== op) throw new Error(`rezervasyon bu arada değişti (${id}); tekrar dene`);
    Object.assign(t.data, { machine: null, machine_reserved: null, launch_op: null });
    saveTask(t);
    releasePin(t.data.parent, machine, id);
    return t;
  });
}

class LostRace extends Error {}

interface RemoteLaunched { branch: string; worktree: string; method?: string; integration?: { branch: string; worktree: string } }
interface OpStatus { state: string; result?: RemoteLaunched }

async function launchRemote(task: Task, o: LaunchOpts, machine: string, remote: RemoteDeps): Promise<Task> {
  const { cfg } = o;
  const { transport } = remote;
  const id = task.data.id;
  const card = projectCard(task.data.project);
  const parent = task.data.parent ?? null;
  const busy = (op: string) => new Error(`önceki launch sürüyor (${machine}, op ${op}); sonra tekrar dene`);

  /** Reserves capacity on `machine` under a fresh `launch_op`, replacing `old` (kb lock, no network). */
  let claimedPin = false;
  const reserve = (old: string | null): Promise<string> => withKbLock(() => {
    const t = getTask(id);
    if (t.data.state !== "queued" || (t.data.launch_op ?? null) !== old) {
      throw new LostRace(`başka deneme kazandı (${id}, launch_op değişti ya da görev artık queued değil); başlatılmadı`);
    }
    const pin = parent ? getTask(parent).data.machine : null;
    if (pin && pin !== machine) throw new Error(`pipeline ${pin} makinesine sabit; ${machine} olamaz`);
    const { load } = machineLoad(listTasks().filter((x) => x.data.id !== id), cfg.brain!, nowMs());
    const cap = capsOf(cfg)[machine];
    if (cap !== undefined && (load[machine] ?? 0) >= cap) throw new Error(`bekliyor — ${id} için makine yok (${machine}: dolu)`);
    const opId = randomUUID();
    Object.assign(t.data, { machine, machine_reserved: new Date(nowMs()).toISOString(), launch_op: opId });
    saveTask(t);
    claimedPin = claimPin(parent, machine); // aynı kilit bölgesinde: eşzamanlı kardeş faz pin'i görür
    return opId;
  });

  /** Verify the reservation is still ours, then record the running task (kb lock). */
  const commit = (opId: string, r: RemoteLaunched): Promise<Task> => withKbLock(() => {
    const t = getTask(id);
    if (t.data.launch_op !== opId || t.data.state !== "queued") {
      throw new LostRace(`başka deneme kazandı (${id}, launch_op değişti ya da görev artık queued değil); yazılmadı`);
    }
    const run = setState(id, "running", { branch: r.branch, worktree: r.worktree, machine, machine_reserved: null, launch_op: null, error: null });
    if (r.integration && parent) recordIntegration(parent, task.data.project, r.integration.branch, r.integration.worktree);
    pinPipeline(parent, machine);
    return run;
  });

  const old = task.data.launch_op ?? null;
  if (old) {
    // an earlier attempt's outcome is unknown: ask the worker before launching again
    let st = (await transport.call<OpStatus>(machine, "op-status", { target: old })).result;
    if (st.state === "unknown") st = (await transport.call<OpStatus>(machine, "op-status", { target: old, cancel: true })).result; // tombstone: it can no longer start
    if (st.state === "done") {
      if (!st.result) throw new Error(`önceki launch tamamlanmış ama sonuç yok (${machine}, op ${old}); elle incele`);
      return commit(old, st.result);
    }
    if (st.state === "started") throw busy(old);
    if (!RETRY_STATES.has(st.state)) throw new Error(`beklenmeyen op-status durumu: ${st.state} (${machine}, op ${old})`);
  }
  if (parent && CLOSED.includes(getTask(parent).data.state)) throw new Error(`çatı görev ${parent} ${getTask(parent).data.state}; fazı başlatılamaz`);
  // built before the reservation: a missing role file must not leave a reservation behind
  const role = task.data.role ? roleFor(task.data.role, task.data.kind) : undefined;
  const model = effectiveModel(task.data, role);
  const def = card.default_branch ?? undefined;
  const args = {
    taskId: id, project: task.data.project, repoName: repoNameOf(card.path), branch: `vlad/${id}`,
    base: parent ? { kind: "integration", parent, ...(def ? { defaultBranch: def } : {}) } : { kind: "default", ...(def ? { defaultBranch: def } : {}) },
    promptTemplate: buildPrompt("{{TASK_FILE}}", task.data.autonomy, role, { taskId: id, parent, projectSkills: card.skills }, true),
    title: `VLAD ${id} — ${task.data.title}`,
    ...(model ? { model } : {}),
    ...(cfg.workerAutoCompact ? { autoCompact: cfg.workerAutoCompact } : {}),
  };
  const op = await reserve(old);

  let res: { result: RemoteLaunched };
  try {
    await remote.syncKb?.(machine);
    res = await transport.call<RemoteLaunched>(machine, "launch", args, { opId: op });
  } catch (e) {
    // no answer: the worker may have launched anyway -> keep the reservation, the next `task launch` asks op-status
    if (e instanceof RemoteError && UNCERTAIN.has(e.code)) throw e;
    await failReservation(id, op, (e as Error).message, claimedPin);
    throw e;
  }
  // the worker did launch: a failure while recording it keeps the reservation (the next launch adopts via op-status)
  return commit(op, res.result);
}

/**
 * machines C1: the worker machine a task runs on, when that is not the brain (null otherwise). Its worktree is not on
 * this machine, so the local resume/cleanup/skills paths must not read or forget it; remote resume/cleanup is C2.
 */
export function remoteMachineOf(t: Task, cfg: VladConfig, self?: string): string | null {
  // `self`: a worker's own name; its own tasks are local to it (F-vlad-149: no remote call to its own Agent)
  return cfg.machines && t.data.machine && t.data.machine !== cfg.brain && t.data.machine !== self ? t.data.machine : null;
}

/** Closes the task's worker window/process tree; the state and the worktree stay as they are. */
export function closeTaskWindow(
  id: string,
  o: { closeWorker?: (taskId: string) => number[] | void } = {},
): { id: string; killed: number[] } {
  getTask(id); // unknown ids fail here
  return { id, killed: (o.closeWorker ?? closeWorkerWindow)(id) ?? [] };
}

/**
 * Closes the worker's window, then removes the worktree of a done/cancelled task.
 * The branch is left alone.
 */
export function cleanupTask(
  id: string,
  o: { closeWorker?: (taskId: string) => void; cfg?: VladConfig } = {},
): void {
  const t = getTask(id);
  if (t.data.state !== "done" && t.data.state !== "cancelled") {
    throw new Error(`cleanup yalnızca done/cancelled görevde yapılır (${t.data.state}): ${id}`);
  }
  if (t.data.kind === "pipeline" && o.cfg) {
    // integration worktrees of the other projects the phases ran in (F-vlad-063); the own one is handled below
    for (const w of integrationWorktrees(id, o.cfg)) {
      if (w.worktree === t.data.worktree || !existsSync(w.worktree)) continue;
      removeTaskWorktree(w.repo, w.worktree, id);
    }
  }
  const wt = t.data.worktree;
  if (!wt) return;
  if (existsSync(wt)) {
    try {
      (o.closeWorker ?? closeWorkerWindow)(id);
    } catch {
      /* a window that could not be closed is reported by the removal below */
    }
    removeTaskWorktree(projectPath(t.data.project), wt, id);
  }
  const trustWarning = untrustWorktree(wt);
  if (trustWarning) console.error(`uyarı: ${trustWarning}`);
  t.data.worktree = null;
  saveTask(t);
}

/**
 * On Windows an open terminal whose cwd is the worktree locks the folder: `git worktree remove`
 * then unregisters the worktree but fails to delete it. A leftover, unregistered folder is
 * deleted directly (retrying while a just-killed window releases it) so that a retry succeeds.
 */
export function removeTaskWorktree(repo: string, wt: string, id: string): void {
  try {
    if (isWorktree(repo, wt)) removeWorktree(repo, wt);
    else { unlinkReparsePoints(wt); rmSync(wt, { recursive: true, force: true }); }
  } catch (e) {
    // fail-closed: links that could not be detached must never reach the retry/rmSync fallback below
    if (e instanceof ReparseCleanupError) {
      throw new Error(
        `worktree bağlantıları kaldırılamadı, silme yapılmadı: ${wt}. \`vlad task cleanup ${id}\` ile tekrar dene. (${e.message})`,
      );
    }
    try {
      unlinkReparsePoints(wt); // git may have failed before touching links; the fallback must not follow one either
      rmSync(wt, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e2) {
      if (e2 instanceof ReparseCleanupError) throw new Error(`worktree bağlantıları kaldırılamadı, silme yapılmadı: ${wt}. (${e2.message})`);
      /* reported below */
    }
    runGit(repo, ["worktree", "prune"]);
    if (!existsSync(wt)) return;
    throw new Error(
      `worktree klasörü silinemedi, çalışan penceresi hâlâ açık olabilir: ${wt}. ` +
        `Pencereyi kapatıp \`vlad task cleanup ${id}\` komutunu tekrar çalıştır. (${(e as Error).message})`,
    );
  }
}

export function statusSummary(
  cfg: VladConfig,
  now: Date,
  probe?: LivenessProbe,
  platform?: NodeJS.Platform,
  /** `mark: false` (status --no-mark) is a pure read: nothing is marked stalled and an elapsed mode window is not cleared. */
  opts: { mark?: boolean; /** machines C3: remote probe results, applied here under the kb lock */ remotePlans?: RemoteStallPlan[] } = {},
): {
  counts: Record<TaskState, number>; active: Task[]; failed: Task[]; newlyStalled: string[]; inbox: number;
  undigested: number; openSevereFindings: number; mode: string | null;
} {
  const mark = opts.mark !== false;
  // a read-only/locked kb must not take the startup summary (SessionStart hook) down: marking is best effort (F-vlad-052)
  const safe = (fn: () => Task[]): Task[] => { try { return fn(); } catch { return []; } };
  const newlyStalled = mark ? [
    ...safe(() => markStale(now, cfg.staleAfterHours)),
    ...safe(() => markSilentWorkers(now, cfg, probe, platform)),
    ...safe(() => applyRemoteStalls(opts.remotePlans ?? [])),
  ].map((t) => t.data.id) : [];
  const mode = modeLine(now);
  if (mark) try { expireMode(now); } catch { /* a locked mode.json must not take the startup summary down */ } // an elapsed window is reported once, then cleared
  const tasks = listTasks();
  const counts = Object.fromEntries(ALL_STATES.map((s) => [s, 0])) as Record<TaskState, number>;
  for (const t of tasks) counts[t.data.state]++;
  return {
    counts,
    active: tasks.filter((t) => ACTIVE.includes(t.data.state)),
    failed: tasks.filter((t) => t.data.state === "failed" || (t.data.state === "queued" && !!t.data.error)),
    newlyStalled,
    inbox: countInbox(),
    undigested: tasks.filter((t) => t.data.state === "done" && !t.data.digested).length,
    openSevereFindings: countOpenSevere(),
    mode,
  };
}
