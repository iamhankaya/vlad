import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commitKb } from "../kb/commit.js";
import { getKbRecord } from "../kb/get.js";
import { loadConfig, readDoc, withKbLock } from "../kb/index.js";
import type { ProjectCard, VladConfig } from "../kb/index.js";
import { kbPaths } from "../kb/home.js";
import { closedFindingTokens, isFullFindingId, partialFindingTokens } from "../findings/closed-report.js";
import { UNRESOLVED, getFinding, listFindingsWithWarnings, setFindingStates } from "../findings/store.js";
import { modeStatus } from "../mode/store.js";
import { refreshProject } from "../projects/derived.js";
import { doneSummaryNote } from "../projects/status.js";
import { cleanupTask, getTask, integrationWorktrees, logTask, setState } from "../tasks/index.js";
import type { Task } from "../tasks/index.js";
import { closeWorkerWindow } from "../launcher/index.js";
import { selfName } from "../fleet/state.js";
import type { BranchPushResult, GateRunResult, MergePreviewResult, MergeResult } from "../fleet/types.js";
import { brainTransport, defaultGateTarget, brainRepoPath, fetchTaskBranch, gateMachineOf, markCleaned, recordGreenGate, remoteBranchPush, remoteCleanup, remoteGateRun, remoteMerge, remoteMergePreview, syncKb } from "./remote.js";

/** `vlad task close`: one command for the gate (precheck → gate → conflict → confirm → merge → done → cleanup → findings → kb). */
export type CloseStepName = "precheck" | "gate" | "push" | "fetch" | "conflict" | "confirm" | "merge" | "done" | "cleanup" | "findings" | "kb";
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
  /** the commit the gate ran on (and the only one the merge may bring); pass it back as --head on the approving run */
  head?: string;
  /** closed findings (fixed by this task) */
  findings?: string[];
}
export interface CloseOpts {
  yes?: boolean; into?: string;
  /** sha (≥7 hex prefix) the user approved at the confirm stop; a different gated head stops before the merge */
  head?: string;
  /** require the green-gate evidence of every card machine even when this is not the final gate */
  allMachines?: boolean;
}

/** Remote (worker machine) half of the gate; defaults go through the Agent transport. */
export interface CloseRemote {
  machine(t: Task): string | null;
  gate(t: Task, target: "integration" | "task", machine: string): Promise<GateRunResult>;
  /** uzak tek görev / çatı kökü: gate'ten sonra, gate'lenen sha ile; hata → close `push`ta durur, merge yok */
  push(t: Task, machine: string, expectHead: string): Promise<BranchPushResult>;
  /** beyinde `fetch origin vlad/<id>` (FETCH_HEAD === expectHead); hata → close `fetch`te durur */
  fetch(t: Task, expectHead: string): Promise<void>;
  /**
   * F-vlad-320 (uzak teslim): confirm sonrası, merge'ten hemen önce işçide `vlad/<id>` ucunun gate'lenen sha olduğunu yeniden doğrular;
   * farklıysa fırlatır → close `merge`de durur (merge/done/cleanup yok). Zorunlu (F-vlad-328): tanımsızsa uzak teslim merge'ten önce durur.
   */
  verifyTip(t: Task, machine: string, expectHead: string): Promise<void>;
  preview(t: Task, machine: string, into?: string): Promise<MergePreviewResult>;
  merge(t: Task, machine: string, into?: string, message?: string): Promise<MergeResult>;
  /** expectHead (uzak teslim): işçide dal ucu bu sha değilse worktree silinmez (F-vlad-320) */
  cleanup(t: Task, machine: string, expectHead?: string): Promise<void>;
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
    push: (t, m, head) => remoteBranchPush(transport(), m, t, head),
    // branch-push idempotenttir ve işçide ucu expectHead'e karşı denetler ([stale_tip]); origin zaten güncelse yeniden itmez (F-vlad-320)
    // asıl doğrulama işçide ve kuyruk içinde ([stale_tip], F-vlad-332: uç origin işlemlerinden sonra da yeniden okunur); buradaki r.head denetimi yalnız bozuk/eski bir Agent yanıtına karşı savunmadır
    verifyTip: async (t, m, head) => { const r = await remoteBranchPush(transport(), m, t, head); if (r.head !== head) throw new Error("işçi dal ucu doğrulanamadı: yanıt gate'lenen sha'yı içermiyor"); },
    fetch: (t, head) => fetchTaskBranch(t, head, cfg),
    preview: (t, m, into) => remoteMergePreview(transport(), m, t, into ? { into } : {}),
    merge: (t, m, into, message) => remoteMerge(transport(), m, t, { ...(into ? { into } : {}), ...(message ? { message } : {}) }),
    cleanup: async (t, m, head) => { await remoteCleanup(transport(), m, t, head); await withKbLock(() => markCleaned(t.data.id)); },
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

/** `out` = stdout only (values to parse); `all` = stdout+stderr (for messages) */
interface G { code: number; out: string; all: string }
function g(cwd: string, args: string[], timeoutMs = 60_000): G {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 << 20 });
  return { code: r.status ?? 128, out: r.stdout ?? "", all: `${r.stdout ?? ""}${r.stderr ?? ""}` };
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
    if (!wasDone && !report && t0.data.kind !== "pipeline") stop("precheck", "kapanış raporu yok");
    const isResearch = t0.data.kind === "research";
    const parent = t0.data.parent ?? null;
    const card = cardOf(t0.data.project);
    const repoDir = brainRepoPath(t0.data.project, d.cfg); // kart yolu başka OS'tansa brain roots (F-vlad-200)
    const remoteMachine = isResearch ? null : d.remote.machine(t0);
    if (parent && !isResearch && !wasDone) {
      const tests = sub(report, "Test sonuçları");
      if (!/entegrasyon/i.test(tests)) stop("precheck", `pipeline fazı: raporun "Test sonuçları"nda entegrasyon branch'i (vlad/${parent}) merge + gate kanıtı yok; çalışandan düzeltme iste`);
      if (/entegrasyon kontrolü kırmızı/i.test(sub(report, "Açık noktalar"))) stop("precheck", "raporun açık noktalarında entegrasyon kontrolü kırmızı");
    }
    // merge target: a phase goes into the integration branch's worktree, anything else into the default branch
    const into = opts.into ?? (parent ? `vlad/${parent}` : card.default_branch);
    if (!isResearch && !into) stop("precheck", `${t0.data.project} kartında default_branch yok; --into ver ya da project set default_branch`);
    let targetDir = repoDir;
    if (parent && !opts.into) {
      const w = integrationWorktrees(parent, d.cfg).find((x) => x.project === t0.data.project);
      if (!w) stop("precheck", `${parent} entegrasyon worktree'si bulunamadı`);
      targetDir = w!.worktree;
    }
    if (t0.data.kind === "pipeline" && !isResearch && !opts.into && integrationWorktrees(id, d.cfg).length > 1) stop("precheck", "çok projeli çatı: integrate skill §5 elle");
    const from = `vlad/${id}`;
    r.target = isResearch ? undefined : into;
    if (wasDone && !isResearch && !remoteMachine && g(repoDir, ["rev-parse", "--verify", "-q", `refs/heads/${from}`]).code === 0
      && g(repoDir, ["merge-base", "--is-ancestor", from, into!]).code !== 0) stop("precheck", `görev done ama ${from}, ${into} içinde değil; merge edilmemiş`);
    // uzak teslim (D-vlad-076): tek görev / çatı kökü işçide gate'lenir, dal origin üzerinden beyne gelir ve merge beyinde olur
    const viaBrain = !!remoteMachine && !isResearch && (t0.data.kind === "pipeline" || !parent);
    if (wasDone && viaBrain) {
      const gh = t0.data.last_green_gate?.head;
      if (gh && !/^[0-9a-f]{40}$/.test(gh)) stop("precheck", `last_green_gate.head geçerli bir sha değil: ${gh.slice(0, 20)}`); // F-vlad-322 C
      if (gh && g(repoDir, ["merge-base", "--is-ancestor", gh, into!]).code !== 0) stop("precheck", `görev done ama gate'lenen head (${gh.slice(0, 12)}), ${into} içinde değil; merge edilmemiş`);
    }
    add("precheck", "ok", wasDone ? "zaten done: kalan adımlar tamamlanıyor" : undefined);

    let gateGreen = wasDone;
    let how = null as string | null; // decide() atar
    // confirm kararı: --yes, ya da açık gece penceresi + yeşil gate + bu görevin açık kritik/yüksek bulgusu yok. Uzak teslimde dış etkili push'tan (D-vlad-076: merge onayının parçası) ÖNCE verilir
    const decide = () => {
      how = opts.yes ? "--yes" : null;
      if (!how) {
        const night = modeStatus(d.now()).night;
        const p1 = listFindingsWithWarnings({ source: id, state: [...UNRESOLVED], severity: ["kritik", "yüksek"] }).findings.length;
        // the night window never covers: a pipeline's final gate and design gates (status skill), or a report that itself lists a critical/high open point
        const reportP1 = /^\s*-\s*\[(kritik|yüksek)\]/mi.test(sub(report, "Açık noktalar"));
        const nightOk = t0.data.kind !== "pipeline" && t0.data.role !== "designer" && !reportP1;
        if (night && nightOk && gateGreen && (night.projects.length === 0 || night.projects.includes(t0.data.project)) && p1 === 0) how = "gece modu";
      }
    };
    const stopConfirm = () => {
      add("confirm", "stopped", "onay gerekli");
      r.stopped_at = "confirm";
      r.reason = `${isResearch ? "kabul" : `${from} → ${into} merge`} için onay gerekli${r.head ? ` (gate'lenen head ${r.head.slice(0, 12)})` : ""}: onaylıysan \`vlad task close ${id} --yes${r.head ? ` --head ${r.head.slice(0, 12)}` : ""}\``;
      return r;
    };
    let gatedHead = ""; // the commit the gate ran on; the merge may bring only this
    if (wasDone) {
      for (const s of ["gate", "conflict", "confirm", "merge", "done"] as const) add(s, "skipped", "görev zaten done");
    } else if (isResearch) {
      add("gate", "skipped", "research: gate/merge yok");
      decide();
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
        gatedHead = gr.head ?? "";
      } else {
        ranOn = d.self ?? "yerel";
        const wt = t0.data.worktree;
        if (!wt || !existsSync(wt)) stop("gate", `görev worktree'si yok (${wt ?? "null"}); gate koşulamaz`);
        if (g(wt!, ["status", "--porcelain"]).out.trim()) stop("gate", `görev worktree'sinde commit'siz değişiklik var (${wt}); gate yeşili merge edilecek kodu yansıtmaz, çalışandan commit iste`);
        const wb = g(wt!, ["branch", "--show-current"]).out.trim();
        if (wb !== `vlad/${id}`) stop("gate", `görev worktree'si vlad/${id} dalında değil (${wb || "detached"})`);
        gatedHead = g(wt!, ["rev-parse", "HEAD"]).out.trim();
        const gr = spawnSync(gateCmd, { cwd: wt!, shell: true, encoding: "utf8", timeout: 25 * 60_000, maxBuffer: 64 << 20 });
        if (gr.status !== 0) stop("gate", `gate kırmızı (çıkış ${gr.status ?? "zaman aşımı"}):\n${tail(`${gr.stdout ?? ""}\n${gr.stderr ?? ""}`)}`);
      }
      // several platforms: every listed machine needs a green gate line for this commit ("Gate <makine>: yeşil <sha>"); enforced at the final gate (pipeline) or with --all-machines, a warning elsewhere
      if ((card.machines?.length ?? 0) >= 2) {
        const enforce = t0.data.kind === "pipeline" || !!opts.allMachines;
        if (!d.self && !remoteMachine) stop("gate", "kart ≥2 makineli ama bu makinenin kimliği belirsiz (VLAD_MACHINE / vlad.local.json self)");
        if (!/^[0-9a-f]{40}$/.test(gatedHead)) stop("gate", "gate head'i (sha) belirlenemedi; çok makine kanıtı sha'ya bağlanır");
        const short = gatedHead.slice(0, 12);
        // evidence is bound to the gated commit: "Gate <makine>: yeşil <sha>" (sha ≥7 hex prefix of the head)
        const has = (text: string, m: string) => [...text.matchAll(new RegExp(`Gate ${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: yeşil ([0-9a-f]{7,40})\\b`, "g"))].some((x) => gatedHead.startsWith(x[1]));
        await withKbLock(() => { if (!has(getTask(id).body, ranOn)) logTask(id, `Gate ${ranOn}: yeşil ${short}`); });
        const logs = `${getTask(id).body}\n${parent ? getTask(parent).body : ""}`;
        const missing = card.machines!.filter((m) => m !== ranOn && !has(logs, m));
        if (missing.length && !enforce) r.warnings.push(`${missing.join(", ")} için bu commit'te (${short}) yeşil gate satırı yok (son kapı değil: yalnız uyarı; zorunlu kılmak için --all-machines)`);
        else if (missing.length) stop("gate", `${missing.join(", ")} için bu commit'te (${short}) yeşil gate yok: o makinede \`vlad task gate ${id} --target ${target} --json\` koş, sonra \`vlad task log ${id} "Gate <makine>: yeşil ${short}"\``);
      }
      gateGreen = true;
      r.head = gatedHead;
      if (opts.head && !(/^[0-9a-f]{7,40}$/i.test(opts.head) && gatedHead.toLowerCase().startsWith(opts.head.toLowerCase()))) stop("gate", `onaylanan head (${opts.head}) ile gate'lenen head (${gatedHead.slice(0, 12)}) farklı; özeti yeniden gözden geçirip yeni head ile onayla`);
      add("gate", "ok", `${ranOn} @ ${gatedHead.slice(0, 12)}`);

      decide();
      // onay yoksa uzak teslimde dal origin'e gitmez (CI tetiklenmesin): push/fetch/conflict atlanır
      if (viaBrain && !how) return stopConfirm();

      // ---- push + fetch (yalnız uzak teslimde): işçi gate'lenen sha'yı origin'e iter, beyin alır; hata → merge yok
      if (viaBrain) {
        if (!/^[0-9a-f]{40}$/.test(gatedHead)) stop("gate", "işçi gate'i head (sha) döndürmedi; dal push edilemez");
        let pr;
        try { pr = await d.remote.push(t0, remoteMachine!, gatedHead); } catch (e) { return stop("push", (e as Error).message); }
        if (pr?.head !== gatedHead) stop("push", "branch-push yanıtı gate'lenen sha'yı doğrulamadı; yeniden koş");
        await withKbLock(() => logTask(id, `branch-push: ${from} @ ${gatedHead.slice(0, 12)} ${pr.pushed ? "origin'e itildi" : "origin'de zaten vardı"} (${remoteMachine})`));
        add("push", "ok", pr.pushed ? gatedHead.slice(0, 12) : "origin'de zaten var");
        try { await d.remote.fetch(t0, gatedHead); } catch (e) { return stop("fetch", (e as Error).message); }
        add("fetch", "ok", gatedHead.slice(0, 12));
      }

      // ---- conflict preview (writes nothing)
      if (remoteMachine && !viaBrain) {
        const p = await d.remote.preview(getTask(id), remoteMachine, opts.into);
        r.summary = `${p.log}${p.diffStat}`;
        if (p.conflicts.length) stop("conflict", `çakışma: ${p.conflicts.join(", ")}`);
      } else {
        const src = viaBrain ? gatedHead : from; // uzak teslimde yerel dal yok: fetch'lenen sha
        const log = g(targetDir, ["log", "--oneline", `${into}..${src}`]).out;
        const stat = g(targetDir, ["diff", "--stat", `${into}...${src}`]).out;
        r.summary = `${log}${stat}`;
        const mt = g(targetDir, ["merge-tree", "--write-tree", "--name-only", into!, src]);
        if (mt.code === 1) {
          const rest = mt.out.split("\n").slice(1); // --name-only: tree id, conflicted paths, blank line, messages
          const names = rest.slice(0, Math.max(0, rest.indexOf(""))).filter(Boolean);
          stop("conflict", `çakışma (${into} ← ${viaBrain ? gatedHead.slice(0, 12) : from}): ${names.join(", ") || tail(mt.all, 5)}`);
        }
        if (mt.code !== 0) r.warnings.push(`merge-tree çalışmadı (git ≥ 2.38 gerekir): çakışma merge sırasında yakalanır — ${tail(mt.all, 2)}`);
      }
      add("conflict", "ok", r.warnings.length ? "ön izleme atlandı" : undefined);
    }

    // ---- confirm: karar decide() ile yukarıda verildi; yalnız durağı/kaydı yazar
    if (!wasDone) {
      if (!how) return stopConfirm();
      add("confirm", "ok", how);

      // ---- merge
      // F-vlad-320: confirm beklerken işçi yeni commit atmış olabilir; gate'siz uç merge edilip görev done olmasın
      // F-vlad-328: doğrulama zorunlu; kanca yoksa (özel/eksik remote) doğrulamasız merge yapılmaz
      if (viaBrain) {
        if (typeof d.remote.verifyTip !== "function") return stop("merge", "işçi dal ucu doğrulanamadı, merge yapılmadı: remote.verifyTip tanımlı değil (verifyTip zorunlu)");
        try { await d.remote.verifyTip(getTask(id), remoteMachine!, gatedHead); } catch (e) { return stop("merge", `işçi dal ucu doğrulanamadı, merge yapılmadı: ${(e as Error).message}`); }
      }
      if (isResearch) add("merge", "skipped", "research: merge yok");
      else if (remoteMachine && !viaBrain) {
        // gate sonrası yeniden oku: last_green_gate t0'da bayat
        const m = await d.remote.merge(getTask(id), remoteMachine, opts.into, `Merge ${from}`);
        r.merged_head = m.head; merged = true;
        add("merge", "ok", m.merged ? m.head : `zaten içeride (${m.head})`);
      } else {
        if (!existsSync(targetDir)) stop("merge", `hedef worktree yok: ${targetDir}`);
        const cur = g(targetDir, ["branch", "--show-current"]).out.trim();
        if (cur !== into) stop("merge", `hedef worktree ${into} dalında değil (${cur || "detached"}): ${targetDir}`);
        if (g(targetDir, ["status", "--porcelain"]).out.trim()) stop("merge", `hedef ağaç temiz değil: ${targetDir}`);
        const tip = viaBrain ? gatedHead /* uzak teslimde sha doğrulaması fetch adımındadır */ : g(repoDir, ["rev-parse", "--verify", "-q", `refs/heads/${from}^{commit}`]).out.trim();
        if (tip !== gatedHead) stop("merge", `${from} ucu gate'ten sonra değişti (gate ${gatedHead.slice(0, 12)}, şimdi ${tip.slice(0, 12) || "yok"}); gate'siz commit merge edilmez, yeniden koş`);
        const mr = g(targetDir, ["-c", "user.name=VLAD", "-c", "user.email=vlad@localhost", "merge", "--no-ff", "-m", `Merge ${from}: ${t0.data.title}`, gatedHead], 5 * 60_000);
        if (mr.code !== 0) {
          if (g(targetDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0) g(targetDir, ["merge", "--abort"]); // not when the failure was e.g. index.lock held by another merge
          stop("merge", `merge başarısız, geri alındı: ${tail(mr.all, 5)}`);
        }
        r.merged_head = g(targetDir, ["rev-parse", "HEAD"]).out.trim(); merged = true;
        add("merge", "ok", r.merged_head);
      }

      // ---- done
      const doneT = await withKbLock(() => setState(id, "done"));
      r.warnings.push(...doneSummaryNote(doneT).warnings);
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
      if (remoteMachine) await d.remote.cleanup(t, remoteMachine, viaBrain ? (gatedHead || t.data.last_green_gate?.head || undefined) : undefined);
      else await withKbLock(() => cleanupTask(id, { cfg: d.cfg, closeWorker: d.closeWorker }));
      return undefined;
    });
    await after("findings", async () => {
      const ids: string[] = [];
      for (const tok of new Set(partialFindingTokens(report))) r.warnings.push(`${tok} kısmi düzeltme olarak yazılmış, kapatılmadı`);
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
