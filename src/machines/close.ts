import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commitKb } from "../kb/commit.js";
import { getKbRecord } from "../kb/get.js";
import { loadConfig, readDoc, withKbLock } from "../kb/index.js";
import type { ProjectCard, VladConfig } from "../kb/index.js";
import { kbPaths } from "../kb/home.js";
import { closedFindingTokens, isFullFindingId } from "../findings/closed-report.js";
import { UNRESOLVED, getFinding, listFindingsWithWarnings, setFindingStates } from "../findings/store.js";
import { modeStatus } from "../mode/store.js";
import { refreshProject } from "../projects/derived.js";
import { cleanupTask, getTask, integrationWorktrees, logTask, setState } from "../tasks/index.js";
import type { Task } from "../tasks/index.js";
import { closeWorkerWindow } from "../launcher/index.js";
import { selfName } from "../fleet/state.js";
import type { GateRunResult, MergePreviewResult, MergeResult } from "../fleet/types.js";
import { brainTransport, defaultGateTarget, gateMachineOf, markCleaned, recordGreenGate, remoteCleanup, remoteGateRun, remoteMerge, remoteMergePreview, syncKb } from "./remote.js";

/** `vlad task close`: one command for the gate (precheck → gate → conflict → confirm → merge → done → cleanup → findings → kb). */
export type CloseStepName = "precheck" | "gate" | "conflict" | "confirm" | "merge" | "done" | "cleanup" | "findings" | "kb";
export interface CloseStep { step: CloseStepName; status: "ok" | "skipped" | "stopped" | "failed"; detail?: string }
export interface CloseResult {
  id: string;
  /** true only when every step ran (or was legitimately skipped) */
  ok: boolean;
  stopped_at: CloseStepName | null;
  reason: string | null;
  steps: CloseStep[];
  warnings: string[];
  target?: string;
  /** log + diff --stat of what the merge brings (shown when it stops for confirmation) */
  summary?: string;
  merged_head?: string;
  /** closed findings (fixed by this task) */
  findings?: string[];
}
export interface CloseOpts { yes?: boolean; into?: string }

/** Remote (worker machine) half of the gate; defaults go through the Agent transport. */
export interface CloseRemote {
  machine(t: Task): string | null;
  gate(t: Task, target: "integration" | "task", machine: string): Promise<GateRunResult>;
  preview(t: Task, machine: string, into?: string): Promise<MergePreviewResult>;
  merge(t: Task, machine: string, into?: string, message?: string): Promise<MergeResult>;
  cleanup(t: Task, machine: string): Promise<void>;
}
export interface CloseDeps {
  cfg: VladConfig;
  now: () => Date;
  /** this machine's name; null when unknown (only needed when the card lists ≥2 machines) */
  self: string | null;
  remote: CloseRemote;
  kbCommit: (msg: string) => { committed: boolean; pushed?: boolean; warning?: string };
  closeWorker: (taskId: string) => void;
}

function defaultRemote(cfg: VladConfig): CloseRemote {
  const transport = () => brainTransport(cfg, selfName());
  return {
    machine: (t) => (cfg.machines ? gateMachineOf(t, cfg) : null),
    gate: async (t, target, m) => { const tr = transport(); await syncKb(tr, m); return remoteGateRun(tr, m, t, target); },
    preview: (t, m, into) => remoteMergePreview(transport(), m, t, into ? { into } : {}),
    merge: (t, m, into, message) => remoteMerge(transport(), m, t, { ...(into ? { into } : {}), ...(message ? { message } : {}) }),
    cleanup: async (t, m) => { await remoteCleanup(transport(), m, t); await withKbLock(() => markCleaned(t.data.id)); },
  };
}
function realDeps(o: Partial<CloseDeps>): CloseDeps {
  const cfg = o.cfg ?? loadConfig();
  let self: string | null = o.self ?? null;
  if (o.self === undefined) { try { self = selfName(); } catch { self = null; } }
  return {
    cfg, self, now: o.now ?? (() => new Date()),
    remote: o.remote ?? defaultRemote(cfg),
    kbCommit: o.kbCommit ?? ((msg) => commitKb(msg, { push: true })),
    closeWorker: o.closeWorker ?? closeWorkerWindow,
  };
}

interface G { code: number; out: string }
function g(cwd: string, args: string[], timeoutMs = 60_000): G {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 << 20 });
  return { code: r.status ?? 128, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const tail = (s: string, n = 30): string => s.trim().split("\n").slice(-n).join("\n");
const cardOf = (slug: string): ProjectCard => {
  const f = join(kbPaths().projects, `${slug}.md`);
  if (!existsSync(f)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  return readDoc<ProjectCard>(f).data;
};
/** Body of a `### <title>` subsection (to the next heading); "" when absent. */
function sub(md: string, title: string): string {
  const m = new RegExp(`^###\\s+${title}\\s*$`, "m").exec(md);
  if (!m) return "";
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^#{1,6}\s/m);
  return end < 0 ? rest : rest.slice(0, end);
}

class Stop extends Error {
  constructor(public step: CloseStepName, msg: string) { super(msg); }
}

export async function closeTask(id: string, opts: CloseOpts = {}, depsIn: Partial<CloseDeps> = {}): Promise<CloseResult> {
  const d = realDeps(depsIn);
  const r: CloseResult = { id, ok: false, stopped_at: null, reason: null, steps: [], warnings: [] };
  const add = (step: CloseStepName, status: CloseStep["status"], detail?: string) => { r.steps.push({ step, status, ...(detail ? { detail } : {}) }); };
  const stop = (step: CloseStepName, msg: string): never => { throw new Stop(step, msg); };
  let merged = false; // the point of no return: after it no step may stop the rest

  try {
    // ---- precheck
    const t0 = getTask(id);
    const wasDone = t0.data.state === "done";
    if (!wasDone && t0.data.state !== "awaiting_approval") stop("precheck", `görev awaiting_approval değil (${t0.data.state}); close yalnız raporu yazılmış görevde çalışır`);
    const report = (() => { try { return getKbRecord(id, "## Kapanış raporu").content.trim(); } catch { return ""; } })();
    if (!wasDone && !report) stop("precheck", "kapanış raporu yok");
    const isResearch = t0.data.kind === "research";
    const parent = t0.data.parent ?? null;
    const card = cardOf(t0.data.project);
    const remoteMachine = isResearch ? null : d.remote.machine(t0);
    if (parent && !isResearch && !wasDone) {
      const tests = sub(report, "Test sonuçları");
      if (!/entegrasyon/i.test(tests)) stop("precheck", `pipeline fazı: raporun "Test sonuçları"nda entegrasyon branch'i (vlad/${parent}) merge + gate kanıtı yok; çalışandan düzeltme iste`);
      if (/entegrasyon kontrolü kırmızı/i.test(sub(report, "Açık noktalar"))) stop("precheck", "raporun açık noktalarında entegrasyon kontrolü kırmızı");
    }
    // merge target: a phase goes into the integration branch's worktree, anything else into the default branch
    const into = opts.into ?? (parent ? `vlad/${parent}` : card.default_branch);
    if (!isResearch && !into) stop("precheck", `${t0.data.project} kartında default_branch yok; --into ver ya da project set default_branch`);
    let targetDir = card.path;
    if (parent && !opts.into) {
      const w = integrationWorktrees(parent, d.cfg).find((x) => x.project === t0.data.project);
      if (!w) stop("precheck", `${parent} entegrasyon worktree'si bulunamadı`);
      targetDir = w!.worktree;
    }
    const from = `vlad/${id}`;
    r.target = isResearch ? undefined : into;
    if (wasDone && !isResearch && !remoteMachine && g(card.path, ["rev-parse", "--verify", "-q", `refs/heads/${from}`]).code === 0
      && g(card.path, ["merge-base", "--is-ancestor", from, into!]).code !== 0) stop("precheck", `görev done ama ${from}, ${into} içinde değil; merge edilmemiş`);
    add("precheck", "ok", wasDone ? "zaten done: kalan adımlar tamamlanıyor" : undefined);

    let gateGreen = wasDone;
    if (wasDone) {
      for (const s of ["gate", "conflict", "confirm", "merge", "done"] as const) add(s, "skipped", "görev zaten done");
    } else if (isResearch) {
      add("gate", "skipped", "research: gate/merge yok");
      add("conflict", "skipped");
    } else {
      // ---- gate (local: card gate in the task worktree; remote: on the worker)
      const gateCmd = card.gate;
      if (!gateCmd) return stop("gate", `gate tanımlı değil — kart için: vlad project set ${t0.data.project} gate "<komut>"`);
      const target = defaultGateTarget(t0);
      let ranOn: string;
      if (remoteMachine) {
        ranOn = remoteMachine;
        const gr = await d.remote.gate(t0, target, remoteMachine);
        if (gr.exit !== 0) stop("gate", `gate kırmızı (${remoteMachine}, çıkış ${gr.exit}):\n${tail(`${gr.stdout}\n${gr.stderr}`)}`);
        await withKbLock(() => recordGreenGate(id, gr, target));
      } else {
        ranOn = d.self ?? "yerel";
        const wt = t0.data.worktree;
        if (!wt || !existsSync(wt)) stop("gate", `görev worktree'si yok (${wt ?? "null"}); gate koşulamaz`);
        const gr = spawnSync(gateCmd, { cwd: wt!, shell: true, encoding: "utf8", timeout: 25 * 60_000, maxBuffer: 64 << 20 });
        if (gr.status !== 0) stop("gate", `gate kırmızı (çıkış ${gr.status ?? "zaman aşımı"}):\n${tail(`${gr.stdout ?? ""}\n${gr.stderr ?? ""}`)}`);
      }
      // several platforms: every listed machine needs a green gate line ("Gate <makine>: yeşil")
      if ((card.machines?.length ?? 0) >= 2) {
        if (!d.self && !remoteMachine) stop("gate", "kart ≥2 makineli ama bu makinenin kimliği belirsiz (VLAD_MACHINE / vlad.local.json self)");
        logTask(id, `Gate ${ranOn}: yeşil`);
        const logs = `${getTask(id).body}\n${parent ? getTask(parent).body : ""}`;
        const missing = card.machines!.filter((m) => m !== ranOn && !new RegExp(`Gate ${m}: yeşil`).test(logs));
        if (missing.length) stop("gate", `${missing.join(", ")} için yeşil gate yok: o makinede \`vlad task gate ${id} --target ${target} --json\` koş, sonra \`vlad task log ${id} "Gate <makine>: yeşil"\``);
      }
      gateGreen = true;
      add("gate", "ok", ranOn);

      // ---- conflict preview (writes nothing)
      if (remoteMachine) {
        const p = await d.remote.preview(t0, remoteMachine, opts.into);
        r.summary = `${p.log}${p.diffStat}`;
        if (p.conflicts.length) stop("conflict", `çakışma: ${p.conflicts.join(", ")}`);
      } else {
        const log = g(targetDir, ["log", "--oneline", `${into}..${from}`]).out;
        const stat = g(targetDir, ["diff", "--stat", `${into}...${from}`]).out;
        r.summary = `${log}${stat}`;
        const mt = g(targetDir, ["merge-tree", "--write-tree", "--name-only", into!, from]);
        if (mt.code === 1) {
          const rest = mt.out.split("\n").slice(1); // --name-only: tree id, conflicted paths, blank line, messages
          const names = rest.slice(0, Math.max(0, rest.indexOf(""))).filter(Boolean);
          stop("conflict", `çakışma (${into} ← ${from}): ${names.join(", ") || tail(mt.out, 5)}`);
        }
        if (mt.code !== 0) r.warnings.push(`merge-tree çalışmadı (git ≥ 2.38 gerekir): çakışma merge sırasında yakalanır — ${tail(mt.out, 2)}`);
      }
      add("conflict", "ok", r.warnings.length ? "ön izleme atlandı" : undefined);
    }

    // ---- confirm: --yes, or an open night window with a green gate and no open critical/high finding of this task
    if (!wasDone) {
      let how: string | null = opts.yes ? "--yes" : null;
      if (!how) {
        const night = modeStatus(d.now()).night;
        const p1 = listFindingsWithWarnings({ source: id, state: [...UNRESOLVED], severity: ["kritik", "yüksek"] }).findings.length;
        if (night && gateGreen && (night.projects.length === 0 || night.projects.includes(t0.data.project)) && p1 === 0) how = "gece modu";
      }
      if (!how) {
        add("confirm", "stopped", "onay gerekli");
        r.stopped_at = "confirm";
        r.reason = `${isResearch ? "kabul" : `${from} → ${into} merge`} için onay gerekli: onaylıysan \`vlad task close ${id} --yes\``;
        return r;
      }
      add("confirm", "ok", how);

      // ---- merge
      if (isResearch) add("merge", "skipped", "research: merge yok");
      else if (remoteMachine) {
        const m = await d.remote.merge(t0, remoteMachine, opts.into, `Merge ${from}`);
        r.merged_head = m.head; merged = true;
        add("merge", "ok", m.merged ? m.head : `zaten içeride (${m.head})`);
      } else {
        if (!existsSync(targetDir)) stop("merge", `hedef worktree yok: ${targetDir}`);
        const cur = g(targetDir, ["branch", "--show-current"]).out.trim();
        if (cur !== into) stop("merge", `hedef worktree ${into} dalında değil (${cur || "detached"}): ${targetDir}`);
        if (g(targetDir, ["status", "--porcelain"]).out.trim()) stop("merge", `hedef ağaç temiz değil: ${targetDir}`);
        const mr = g(targetDir, ["-c", "user.name=VLAD", "-c", "user.email=vlad@localhost", "merge", "--no-ff", "-m", `Merge ${from}: ${t0.data.title}`, from], 5 * 60_000);
        if (mr.code !== 0) {
          g(targetDir, ["merge", "--abort"]);
          stop("merge", `merge başarısız, geri alındı: ${tail(mr.out, 5)}`);
        }
        r.merged_head = g(targetDir, ["rev-parse", "HEAD"]).out.trim(); merged = true;
        add("merge", "ok", r.merged_head);
      }

      // ---- done
      await withKbLock(() => setState(id, "done"));
      try { refreshProject(t0.data.project, { create: false, only: "activity" }); } catch (e) { r.warnings.push(`kart bloğu tazelenemedi: ${(e as Error).message}`); }
      add("done", "ok");
    }

    // ---- post-merge steps: each isolated, none can undo the merge (re-run `close` finishes what failed)
    const after = async (step: CloseStepName, fn: () => Promise<string | undefined> | string | undefined) => {
      try { const detail = await fn(); add(step, detail === "skipped" ? "skipped" : "ok", detail === "skipped" ? undefined : detail); }
      catch (e) { add(step, "failed", (e as Error).message); r.stopped_at ??= step; r.reason ??= `${step} başarısız: ${(e as Error).message}`; }
    };
    await after("cleanup", async () => {
      const t = getTask(id);
      if (!t.data.worktree) return "skipped";
      if (remoteMachine) await d.remote.cleanup(t, remoteMachine);
      else await withKbLock(() => cleanupTask(id, { cfg: d.cfg, closeWorker: d.closeWorker }));
      return undefined;
    });
    await after("findings", async () => {
      const ids: string[] = [];
      for (const tok of new Set(closedFindingTokens(report))) {
        if (!isFullFindingId(tok)) { r.warnings.push(`kısaltılmış/aralık bulgu ID'si "${tok}" kapatılmadı`); continue; }
        try {
          const f = getFinding(tok);
          if (f.data.state === "open" || f.data.state === "deferred") ids.push(tok);
          else r.warnings.push(`${tok} zaten kapalı (${f.data.state})`);
        } catch { r.warnings.push(`${tok} bilinmiyor (bulgu kaydı yok)`); }
      }
      if (!ids.length) return "skipped";
      await withKbLock(() => setFindingStates(ids, "fixed", { by: id }));
      r.findings = ids;
      try { refreshProject(t0.data.project, { create: false, only: "findings" }); } catch { /* the card block is refreshed by the next write */ }
      return ids.join(", ");
    });
    await after("kb", () => {
      const k = d.kbCommit(`görev ${id} kapatıldı: ${t0.data.title}`);
      if (k.warning) r.warnings.push(k.warning);
      if (k.committed && k.pushed === false) r.warnings.push("kb commit'i push edilmedi");
      return k.committed ? "commit" : "kb'de değişiklik yok";
    });
    r.ok = r.stopped_at === null;
    return r;
  } catch (e) {
    if (e instanceof Stop) {
      add(e.step, "stopped", e.message);
      r.stopped_at = e.step; r.reason = e.message;
      return r;
    }
    if (merged) { // unexpected failure after the merge: report it as the step that was running, never pretend nothing happened
      r.stopped_at = r.steps.some((s) => s.step === "done") ? "cleanup" : "done";
      r.reason = (e as Error).message;
      add(r.stopped_at, "failed", r.reason);
      return r;
    }
    throw e;
  }
}
