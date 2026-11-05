#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command, CommanderError } from "commander";
import { addFinding, getFinding, listFindingsWithWarnings, parseFilter, setFindingState, SEVERITIES, STATES } from "./findings/store.js";
import { auditSetup } from "./audit/setup.js";
import { auditSkills } from "./audit/skills.js";
import { expireMode, modeLine, modeStatus, setNight, setOff, setWatch } from "./mode/store.js";
import { idleTasks, probeRemoteWorkers, soleTranscriptSession } from "./tasks/liveness.js";
import { trustWorktree } from "./tasks/trust.js";
import type { RemoteStallPlan } from "./tasks/liveness.js";
import { probeIntegrationBranch } from "./tasks/cloud.js";
import { listInboxWithWarnings, markDone } from "./inbox/inbox.js";
import { installGlobal } from "./install.js";
import { checkKb, kbCheckExitCode } from "./kb/check.js";
import { commitKb } from "./kb/commit.js";
import { readInput } from "./kb/input.js";
import { formatLint, lintExitCode, lintKb } from "./kb/lint.js";
import { lintAgeNote, writeLintCache } from "./kb/lint-cache.js";
import { formatRefs, refsOf } from "./kb/refs.js";
import { addDecision, appendJournal, getJournal, getVladHome, kbPaths, getKbRecord, listDecisions, isDecisionExpired, loadConfig, maintainKb, migrateDecisions, searchKb, setDecisionStatus, withKbLock, KbLockTimeout, DECISION_STATUSES, ValidationError, writeFileAtomic } from "./kb/index.js";
import type { TaskKind, TaskState, VladConfig } from "./kb/index.js";
import { NoopLauncher, PosixLauncher, TerminalLauncher, desktopQueueDir, enqueueDesktop, externalLaunch, secureDir, queueLauncher, resolveLaunchMode } from "./launcher/index.js";
import { swallowEpipe } from "./stdout.js";
import { exitCodeFor, remoteErrorDetails } from "./machines/exit.js";
import { brainTransport, gateMachineOf, makeRemote, markCleaned, syncKb, remoteCleanup, remoteClose, recordGreenGate, defaultGateTarget, remoteGateRun, remoteMerge, remoteMergePreview, remoteResume } from "./machines/remote.js";
import { INNER_LOCK, lockPolicyOf } from "./machines/lock-policy.js";
import { forwardIfWorker, runRemote, callLocal, workerContext } from "./agent/forward.js";
import { agentKeygen, agentSetKey, agentStart, agentStatus } from "./agent/start.js";
import { installPlan } from "./agent/install.js";
import { readLocal, selfName } from "./agent/state.js";
import { AgentClient } from "./agent/client.js";
import type { LaunchMode, LaunchResult, Launcher } from "./launcher/index.js";
import { projectStatus, setProjectSummary } from "./projects/status.js";
import { activityListsId, refreshAllProjects, refreshProject } from "./projects/derived.js";
import { staleSummaryText } from "./projects/status.js";
import { addPending, donePending, listPending } from "./digest/pending.js";
import { addProjectNote, listProjectsWithWarnings, setProjectField, writeProject } from "./projects/store.js";
import { listRolesWithWarnings } from "./roles/store.js";
import { scanRootsWithWarnings } from "./scan/scan.js";
import {
  TRANSITIONS, TransitionError, answerTask, askTask, cancelTask, cleanupTask, closeTaskWindow, createTask, integrationWorktrees, launchTask, releaseTask, releaseWarning, remoteMachineOf, listTasksWithWarnings, modelInfo,
  eventList, getTask, ingestEvents, logTask, pageWarnings, parseEvents, markDigested, prepareCloudLaunch, readyWithLimit, reportReferencesPrior, reportTask, resumeLocalCheck, resumePrepare, saveTask, setDependencies, setState, statusSummary, unknownTaskRefs, unmetDependencies,
} from "./tasks/index.js";
import type { Task } from "./tasks/index.js";

interface Opts { json?: boolean; [k: string]: unknown }

const wantsJson = () => process.argv.includes("--json");

swallowEpipe(process.stdout);
swallowEpipe(process.stderr);

function fail(e: unknown): never {
  let error = e instanceof Error ? e.message : String(e);
  let details: string[] = [];
  if (e instanceof ValidationError) details = e.details;
  else if (e instanceof TransitionError) details = [`izin verilenler: ${TRANSITIONS[e.from].join(", ") || "(yok)"}`];
  else details = remoteErrorDetails(e);
  if (wantsJson()) process.stderr.write(JSON.stringify({ error, details }) + "\n");
  else {
    error = `hata: ${error}`;
    process.stderr.write([error, ...details.map((d) => `  ${d}`)].join("\n") + "\n");
  }
  process.exit(exitCodeFor(e));
}

/** vlad install: sağ tık "Gönder" menüsü (aktarım). Tek karşı makine yoksa atlanır; --dry-run hiçbir şeye dokunmaz. */
async function sendMenuActions(dryRun: boolean, uninstall = false): Promise<string[]> {
  let cfg: ReturnType<typeof loadConfig>;
  try { cfg = loadConfig(); } catch { return ["sağ tık menüsü atlandı: yapılandırma okunamadı"]; }
  if (!cfg.machines) return ["sağ tık menüsü atlandı: machines yok"];
  let self: string;
  try { self = selfName(); } catch { return ["sağ tık menüsü atlandı: makine kimliği belirsiz (VLAD_MACHINE / vlad.local.json self)"]; }
  const others = cfg.machines.filter((m) => m.name !== self);
  const me = cfg.machines.find((m) => m.name === self);
  if (!me || others.length !== 1) return ["sağ tık menüsü atlandı: karşı makine tek değil"];
  const { installSendMenu } = await import("./menu/index.js");
  const servicesDir = process.env.VLAD_SERVICES_DIR || join(homedir(), "Library", "Services");
  return (await installSendMenu({ os: me.os, node: process.execPath, cli: fileURLToPath(import.meta.url), home: getVladHome(), peer: others[0]!.name, servicesDir, dryRun, uninstall, self, userProfile: process.env.USERPROFILE })).actions;
}

function out(o: Opts, data: unknown, text: string): void {
  process.stdout.write((o.json ? JSON.stringify(data) : text) + "\n");
}

// --- machines:A --- `@<makine>` eki: yalnız görevde machine varsa ve brain değilse
let brainName: string | null | undefined; // config bir kez okunur (liste satırı başına değil)
const machineTag = (t: Task): string => {
  if (!t.data.machine) return "";
  if (brainName === undefined) { try { brainName = loadConfig().brain ?? null; } catch { brainName = null; } }
  return brainName && t.data.machine !== brainName ? ` @${t.data.machine}` : "";
};
// --- /machines:A ---
const taskLine = (t: Task) => `${t.data.id}  ${t.data.state.padEnd(17)} ${t.data.project}  ${t.data.title}${machineTag(t)}`;
/** Pipeline tasks carry their per-project integration worktrees (F-vlad-063); a missing project card must not break listing. */
const integrationInfo = (t: Task, all?: Task[]) => {
  if (t.data.kind !== "pipeline") return {};
  try { return { integration_worktrees: integrationWorktrees(t.data.id, loadConfig(), all) }; } catch { return {}; }
};
/** Task data plus the model it runs on (task `model` ?? role `model`), for --json consumers. */
const withModel = (t: Task, all?: Task[]) => ({ ...t.data, ...modelInfo(t.data), ...integrationInfo(t, all) });
/** Fields `task list --fields` can pick: the task frontmatter plus derived ones (computed only when asked for). */
const TASK_FIELDS = ["id", "project", "title", "kind", "state", "autonomy", "branch", "worktree", "session_id", "created", "updated", "error", "digested", "role", "parent", "depends_on", "phase", "report_file", "model", "model_reason", "machine", "machine_reserved", "launch_op"];
const DERIVED_FIELDS = ["role_model", "effective_model", "integration_worktrees"];
/** Detailed status line: shows the model only when the task's own model deviates from its role's. */
const statusLine = (t: Task) => {
  const m = t.data.model && t.data.model !== modelInfo(t.data).role_model ? `  [model: ${t.data.model}]` : "";
  return taskLine(t) + m;
};

// commander writes the help of a bare group ("vlad", "vlad task") to writeErr before throwing
// commander.help; keep it so the catch below can show it instead of a bare "(outputHelp)" error.
let pendingHelp = "";
const program = new Command();
program
  .name("vlad")
  .description("VLAD: Claude Code orkestratörü")
  .exitOverride()
  .configureOutput({ writeErr: (str) => { pendingHelp += str; } });

/**
 * Commands that write the kb run under the cross-process kb lock (F-vlad-096): ID generation and the write
 * share one lock region. Read-only commands, `kb commit` (takes the lock itself around add+commit only, never during the push; F-vlad-103) and
 * `task close-window` (no kb write) stay lock-free. `task launch` locks only its kb write regions inside
 * `launchTask` (F-vlad-102), never the worktree/terminal wait. `status`/`mode status` write only as a side effect
 * (stalled marks, expired mode window), so they lock unless `--no-mark` is given.
 */
const KB_WRITES = new Set([
  "project write", "project set", "project note", "project summary", "project refresh",
  "finding add", "finding set",
  "task new", "task ingest", "task resume", "task log", "task ask", "task answer", "task report", "task set", "task deps", "task cleanup", "task digested", "task session",
  "mode night", "mode watch", "mode off", "mode status",
  "inbox done", "pending add", "pending done", "decision add", "decision set", "decision migrate", "journal append", "kb maintain", "session register",
]);

// --- machines:S --- kancalar; varsayılan = mevcut davranış. B `before`'ı (iletim), C `lockPolicy`'yi (resume/cleanup iç kilit) doldurur.
/** true → komut başka makineye iletildi (çıktı yazıldı), yerel handler çalışmaz. */
const before = (key: string, args: any[]): Promise<boolean> => forwardIfWorker(key, args);
/** "outer": tüm callback kilitli (bugünkü KB_WRITES); "inner": handler kendi evrelerinde kilitler; "none". */
const lockPolicy = (key: string): "outer" | "inner" | "none" => lockPolicyOf(key, KB_WRITES, INNER_LOCK.has(key) ? loadConfig() : {}); // C1: resume/cleanup lock in phases once `machines` is set
// --- /machines:S ---
// --- machines:C3 --- uzak stalled: ağ çağrıları kilit DIŞINDA (status'un kilitli gövdesi yalnız sonucu uygular); --no-mark ve --hook yolunda hiç bağlantı yok
async function remoteStallPlans(): Promise<RemoteStallPlan[]> {
  try {
    const cfg = loadConfig();
    if (!cfg.machines || !cfg.brain || selfName() !== cfg.brain) return [];
    return await probeRemoteWorkers(cfg, new AgentClient({ self: cfg.brain, keys: readLocal().keys, config: () => cfg }), new Date());
  } catch (e) { process.stderr.write(`uyarı: uzak stalled denetimi atlandı: ${(e as Error).message}\n`); return []; } // a broken probe must never take status down
}
// --- /machines:C3 ---

/** Registers a command with --json and a uniform error path. */
/** Records a command changed show up in the project card's derived blocks (open findings, Son aktivite) right away; a refresh failure never fails the command. */
/** Projects whose derived block `which` a command may have changed; each hook refreshes only that block (a task scan costs ~1.7 s on 600+ tasks). */
function targetsOf(key: string, args: any[]): { slugs: (string | undefined)[]; only: "findings" | "activity"; fast?: boolean } | null {
  const o = args[args.length - 2] as Opts;
  switch (key) {
    case "project write": return { slugs: [String(args[0])], only: "findings" }; // the card was replaced: the findings block is cheap, activity waits for `project refresh`
    case "finding add": return { slugs: [String(o.project)], only: "findings" };
    case "finding set": return { slugs: [getFinding(String(args[0])).data.project], only: "findings" };
    // an added decision only pushes entries out of the list: no task scan (fast). One that leaves the valid list (`set`, or the superseded one) matters only when the block shows it, and then needs the scan.
    // the superseded decision may belong to another project: that card's block still lists it (F-vlad-190)
    case "decision add": return { slugs: [String(o.project), decisionProject(o.supersedes)], only: "activity", fast: !o.supersedes };
    case "decision set": {
      const id = String(args[0]), p = decisionProject(id);
      if (p && args[1] !== "geçerli" && !activityListsId(p, id)) return null;
      return { slugs: [p], only: "activity" };
    }
    case "task set": return String(args[1]) === "done" ? { slugs: [getTask(String(args[0])).data.project], only: "activity" } : null;
  }
  return null;
}
/** `D-<proje>-NNN` → proje slug'ı (kimlik değilse undefined). */
const decisionProject = (id: unknown): string | undefined => /^D-([a-z0-9][a-z0-9-]*)-\d{3,}$/.exec(String(id ?? ""))?.[1];
const REFRESH_KEYS = new Set(["project write", "finding add", "finding set", "task set", "decision add", "decision set"]);
async function runAndRefresh(key: string, args: any[], fn: (...a: any[]) => void | Promise<void>): Promise<void> {
  await fn(...args);
  if (!REFRESH_KEYS.has(key)) return;
  try {
    const t = targetsOf(key, args);
    for (const slug of new Set(t?.slugs)) {
      if (slug && /^[a-z0-9-]+$/.test(slug) && existsSync(join(kbPaths().projects, `${slug}.md`))) refreshProject(slug, { create: false, only: t!.only, fast: t!.fast });
    }
  } catch (e) { process.stderr.write(`uyarı: kart blokları tazelenemedi: ${(e as Error).message}\n`); }
}

function def(parent: Command, spec: string, desc: string, fn: (...a: any[]) => void | Promise<void>): Command {
  const c = parent.command(spec).description(desc).option("--json", "makine okunur çıktı");
  const key = `${parent.name()} ${spec.split(" ")[0]}`;
  c.action(async (...args: any[]) => {
    try {
      const opts = args[args.length - 2] as Opts;
      if (key === "vlad status" && workerContext()) opts.mark = false; // işçinin kb klonu salt okunur: işaretleme/mod temizliği yazmaz (kb-sync kirli ağaçta reddeder)
      if (key === "vlad status" && opts.mark !== false) {
        if (!opts.hook) opts.remotePlans = await remoteStallPlans(); // C3
        // SessionStart hook runs this: never block it behind a long writer; fall back to the side-effect-free read
        try { await withKbLock(() => fn(...args), { timeoutMs: 2000 }); } catch (e) {
          if (!(e instanceof KbLockTimeout)) throw e;
          opts.mark = false;
          await fn(...args);
        }
      } else if (await before(key, args)) return;
      else await (lockPolicy(key) === "outer" ? withKbLock(() => runAndRefresh(key, args, fn)) : fn(...args));
    } catch (e) {
      fail(e);
    }
  });
  return c;
}

def(program, "scan", "Kök klasörleri tara (kart yazmaz)", (o: Opts) => {
  const { repos, warnings } = scanRootsWithWarnings(loadConfig());
  out(
    o,
    { repos, warnings },
    [...repos.map((r) => `${r.slug}  ${r.path}${r.hasCard ? "" : "  (kart yok)"}`), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
  );
});

const project = program.command("project").description("Proje kartları");
def(project, "write <slug>", "Kartı doğrulayıp yazar", (slug: string, o: Opts) => {
  const card = writeProject(slug, readInput(o.file as string));
  out(o, { slug: card.slug }, `yazıldı: ${card.slug}`);
}).requiredOption("--file <md>", "kart dosyası (- = stdin)");
def(project, "set <slug> <field> <value>", "Tek kart alanını yazar (exposure|repo|default_branch|local_only|local_only_reason|gate|machines); boş değer alanı siler", (slug: string, field: string, value: string, o: Opts) => {
  setProjectField(slug, field, value);
  out(o, { slug, field, value: value === "" ? null : value }, value === "" ? `silindi: ${slug}.${field}` : `yazıldı: ${slug}.${field}=${value}`);
});
def(project, "note <slug> [not]", "Karta `## Çalışma notları` altına tarihli not ekler (--file: çok satırlı, - = stdin)", (slug: string, note: string | undefined, o: Opts) => {
  const text = o.file ? readInput(o.file as string) : note ?? "";
  const line = addProjectNote(slug, text);
  out(o, { slug, note: line }, `not eklendi: ${slug}`);
}).option("--file <md>", "not dosyası (- = stdin)");
def(project, "status <slug>", "Proje durum özeti: kayıtlardan üretilen sayılar/listeler + kartın `## Durum özeti` anlatısı (güncel/bayat/yok)", (slug: string, o: Opts) => {
  const s = projectStatus(slug);
  const lines = [
    `${s.slug}  ${s.status}${s.gate ? `  gate: ${s.gate}` : ""}`,
    `özet: ${s.summary.state}${s.summary.as_of ? ` (${s.summary.as_of} tarihine kadar)` : ""}${s.summary.newer.length ? `  yeni kayıt: ${s.summary.newer.join(", ")}` : ""}`,
    ...(s.summary.text ? ["", s.summary.text] : []),
    "",
    `görevler: ${Object.entries(s.tasks.counts).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`,
    ...s.tasks.active.map((t) => `  ${t.id}  ${t.state}  ${t.title}`),
    ...(s.tasks.last_done ? [`son done: ${s.tasks.last_done.id}  ${s.tasks.last_done.title}`] : []),
    `açık bulgu: ${Object.entries(s.findings.counts).map(([k, v]) => `${k}=${v}`).join(" ") || "yok"}`,
    ...s.findings.open.map((f) => `  ${f.id}  ${f.severity}  ${f.state}  ${f.title}`),
    `geçerli karar: ${s.decisions.total}${s.decisions.total > s.decisions.recent.length ? ` (son ${s.decisions.recent.length}; tümü: vlad decision list --project ${s.slug})` : ""}`,
    ...s.decisions.recent.map((d) => `  ${d.id}  ${d.date}  ${d.title}${d.expired ? `  (süresi doldu: ${d.until})` : ""}`),
    ...(s.decisions.expired.length ? [`süresi dolmuş geçerli karar: ${s.decisions.expired.join(", ")} (yenile ya da vlad decision set <id> geçersiz)`] : []),
  ];
  out(o, s, lines.join("\n"));
});
def(project, "summary <slug>", "Kartın `## Durum özeti` bölümünü yazar (/digest); ilk satıra 'Güncel' damgası eklenir", (slug: string, o: Opts) => {
  const stamp = setProjectSummary(slug, readInput(o.file as string));
  out(o, { slug, as_of: stamp }, `özet yazıldı: ${slug} (${stamp})`);
}).requiredOption("--file <md>", "özet metni (- = stdin); en çok ~1000 token");
def(project, "refresh [slug]", "Kartın koddan üretilen bloklarını (açık bulgular, Son aktivite) yeniden üretir; blok dışı metne dokunmaz", (slug: string | undefined, o: Opts) => {
  if (o.all) {
    const r = refreshAllProjects();
    out(o, r, [`tazelendi: ${r.refreshed.join(", ") || "(değişen yok)"}`, ...r.warnings.map((w) => `uyarı: ${w}`)].join("\n"));
    return;
  }
  if (!slug) throw new Error("proje slug'ı ya da --all gerekli");
  if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(join(kbPaths().projects, `${slug}.md`))) throw new Error(`proje kartı bulunamadı: ${slug}`);
  const changed = refreshProject(slug);
  out(o, { slug, changed }, changed ? `tazelendi: ${slug}` : `güncel: ${slug}`);
}).option("--all", "tüm kartlar");
def(project, "list", "Kartları listeler", (o: Opts) => {
  const { projects, warnings } = listProjectsWithWarnings();
  out(
    o,
    { projects, warnings },
    [...projects.map((p) => `${p.slug}  ${p.status}  ${p.path}${p.exposure ? `  [${p.exposure}]` : ""}${p.gate ? `  gate: ${p.gate}` : ""}`), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
  );
});

const finding = program.command("finding").description("Bulgu kaydı (ertelenen/açık noktalar)");
const findingLine = (f: { data: { id: string; severity: string; state: string; project: string; title: string; fixed_by?: string | null } }) =>
  `${f.data.id}  ${f.data.severity.padEnd(7)} ${f.data.state.padEnd(8)} ${f.data.title}${f.data.fixed_by ? `  (düzeltti: ${f.data.fixed_by})` : ""}`;
def(finding, "add", "Bulgu kaydı oluşturur (varsayılan open)", (o: Opts) => {
  const f = addFinding({
    project: o.project as string, severity: o.severity as string, source: o.source as string, title: o.title as string,
    detail: o.detailFile ? readInput(o.detailFile as string) : undefined, state: o.state as string | undefined,
  });
  out(o, { id: f.data.id }, f.data.id);
})
  .requiredOption("--project <slug>", "proje slug'ı")
  .requiredOption("--severity <önem>", SEVERITIES.join(" | "))
  .requiredOption("--source <görev>", "bulguyu raporlayan görev ID'si")
  .requiredOption("--title <başlık>", "bulgu başlığı")
  .option("--detail-file <md>", "ayrıntı (- = stdin)")
  .option("--state <durum>", "open | deferred", "open");
def(finding, "list", "Bulguları listeler", (o: Opts) => {
  const { findings, warnings } = listFindingsWithWarnings({
    project: o.project as string | undefined,
    state: o.state ? parseFilter(String(o.state), STATES, "durum") : undefined,
    severity: o.severity ? parseFilter(String(o.severity), SEVERITIES, "önem") : undefined,
  });
  out(
    o,
    { findings: findings.map((f) => ({ ...f.data, detail: f.body.replace(/^## Ayrıntı\n?/, "").trim() })), warnings },
    [...findings.map(findingLine), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
  );
})
  .option("--project <slug>", "proje slug'ı")
  .option("--state <durumlar>", `virgülle ayrılmış: ${STATES.join(", ")}`)
  .option("--severity <önemler>", `virgülle ayrılmış: ${SEVERITIES.join(", ")}`);
def(finding, "set <id> <state>", "Bulgunun durumunu değiştirir", (id: string, state: string, o: Opts) => {
  const f = setFindingState(id, state, o.by as string | undefined);
  out(o, { id, state: f.data.state, fixed_by: f.data.fixed_by ?? null }, `${id} -> ${f.data.state}`);
}).option("--by <görev>", "düzelten görev (yalnızca fixed)");

const role = program.command("role").description("Uzman roller");
def(role, "list", "roles/ altındaki rolleri listeler", (o: Opts) => {
  const { roles, warnings } = listRolesWithWarnings();
  out(
    o,
    { roles, warnings },
    [...roles.map((r) => `${r.slug}  ${r.kind}  ${r.title}`), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
  );
});

const task = program.command("task").description("Görevler");
def(task, "new", "queued görev oluşturur", (o: Opts) => {
  const body = o.bodyFile ? readInput(o.bodyFile as string) : "";
  const dependsOn = o.dependsOn ? String(o.dependsOn).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const t = createTask({
    project: o.project as string, title: o.title as string, kind: o.kind as TaskKind, body, role: o.role as string | undefined,
    parent: o.parent as string | undefined, dependsOn, phase: o.phase as string | undefined,
    model: o.model as string | undefined, modelReason: o.modelReason as string | undefined,
  });
  const warnings = unknownTaskRefs(body).map((id) => `gövdede kb'de olmayan görev ID'si: ${id}`);
  out(o, { id: t.data.id, warnings }, [t.data.id, ...warnings.map((w) => `uyarı: ${w}`)].join("\n"));
})
  .option("--role <slug>", "roles/<slug>.md uzman rolü (advisory → research, executor → dev)")
  .option("--model <m>", "görev modeli: haiku | sonnet | opus (rolün modelini ezer)")
  .option("--model-reason <gerekçe>", "model gerekçesi; opus için zorunlu")
  .option("--parent <id>", "çatı (pipeline) görevi")
  .option("--depends-on <ids>", "virgülle ayrılmış, aynı pipeline'daki bağımlılıklar")
  .option("--phase <ad>", "faz adı (spec, tasarım, plan, sözleşme, kabul, karakterizasyon, uygulama, doğrulama, denetim, prova, danışma)")
  .requiredOption("--project <slug>", "proje slug'ı")
  .requiredOption("--title <başlık>", "görev başlığı")
  .option("--kind <kind>", "dev | research | pipeline", "dev")
  .option("--body-file <md>", "görev gövdesi (- = stdin)");

def(task, "launch <id>", "Worktree + branch açar, running yapar, Launcher'ı çağırır", async (id: string, o: Opts) => {
  const cfg = loadConfig();
  if (o.external && o.dryRun) throw new Error("--external ve --dry-run birlikte kullanılamaz");
  let mode: LaunchMode;
  try {
    // a dry run only prints the terminal command, so the test guard does not apply
    mode = resolveLaunchMode(cfg.launcher, process.platform, o.dryRun ? { ...process.env, VLAD_LAUNCHER: "" } : process.env);
  } catch (e) {
    if (!o.dryRun && !(o.external && cfg.launcher !== "cloud")) throw e; // --external opens nothing, so a platform without a terminal is fine; a dry run only prints the terminal command, so it works anywhere
    mode = "auto-terminal";
  }
  if (mode === "cloud") {
    if (o.external) throw new Error("--external yerel çalışan içindir; bulut modunda kullanılamaz");
    const remoteBranch = probeIntegrationBranch(id); // network outside the kb lock (F-vlad-110)
    const r = await withKbLock(() => prepareCloudLaunch(id, { remoteBranch }));
    out(o, r, `${id} bulut çalışanı için hazır (running)\nrepo: ${r.repo}\nbranch: ${r.outcome_branch}\n` +
      `base: ${r.base_branch}\n${r.next.map((n) => `- ${n}`).join("\n")}` +
      r.warnings.map((w) => `\nuyarı: ${w}`).join(""));
    return;
  }
  let last: LaunchResult | undefined;
  // --external (vlad-desktop): only writes the script; the caller opens it, so no terminal and no noop guard
  // VLAD_DESKTOP_QUEUE (vlad-desktop main tab): same preparation as --external plus a queue file the app picks up; explicit --external keeps the old behavior
  const q = o.external || o.dryRun ? { dir: null as string | null } : desktopQueueDir();
  if ("warning" in q && q.warning) process.stderr.write(`uyarı: ${q.warning}\n`);
  const normal: Launcher = mode === "noop"
    ? new NoopLauncher()
    : mode === "tmux" || mode === "terminal"
      ? new PosixLauncher({ mode, dryRun: !!o.dryRun })
      : new TerminalLauncher({ mode: mode === "wt" || mode === "powershell" ? mode : "auto", dryRun: !!o.dryRun });
  const real: Launcher = o.external
    ? new TerminalLauncher({ mode: "auto", external: true })
    : q.dir ? queueLauncher(q.dir, "launch", normal) : normal;
  const launcher: Launcher = { launch: async (req) => (last = await real.launch(req)) };
  // --- machines:C1 --- yerleştirme; C2: uzak taşıma (AgentClient) + launch öncesi kb-sync
  if (o.external && cfg.machines && o.machine && o.machine !== cfg.brain) throw new Error("--external uzak makinede desteklenmez");
  const t = await launchTask(id, { launcher, cfg, ...(o.external ? { external: true } : {}), ...(o.dryRun ? { dryRun: true } : {}), ...(o.machine ? { machine: o.machine as string } : {}), ...(cfg.machines ? { remote: makeRemote(cfg, selfName()) } : {}) });
  // --- /machines:C1 ---
  out(
    o,
    { id, state: t.data.state, branch: t.data.branch, worktree: t.data.worktree, method: last?.method, detail: last?.detail, ...(o.external ? { script: last?.script, command: last?.command, cwd: last?.cwd } : {}), ...(last?.queued ? { queued: last.queued, script: last.script, cwd: last.cwd } : {}) },
    `${id} başlatıldı (${last?.method}) -> ${t.data.worktree}${o.dryRun ? "\n(dry-run) " + (last?.detail ?? "") : ""}${o.external ? `\ncommand: ${last?.command}` : ""}${last?.queued ? `\nkuyruk: ${last.queued}` : ""}`,
  );
}).option("--dry-run", "terminal açmadan komutu göster")
  .option("--machine <ad>", "görevi kartın makinelerinden birine sabitle (yalnız config'te machines varken)")
  .option("--external", "terminal açma; betiği yaz, script/command/cwd döndür (gömülü kullanım)");

def(task, "release <id>", "Belirsiz uzak launch rezervasyonunu (ve çatı makine pin'ini) bırakır; işçi launch'ı görmediyse iptal işareti yazılır", async (id: string, o: Opts) => {
  const cfg = loadConfig();
  const t = await releaseTask(id, { cfg, ...(cfg.machines ? { transport: brainTransport(cfg, selfName()) } : {}), ...(o.force ? { force: true } : {}) });
  const warn = releaseWarning(t);
  out(o, { id, state: t.data.state, ...(warn ? { warning: warn } : {}) }, `${id} rezervasyonu bırakıldı (${t.data.state})${warn ? `\n${warn}` : ""}`);
}).option("--force", "işçiye ulaşılamıyorsa da bırak (kalıcı ölü makine; launch açılmışsa orada yetim kalır)");

def(task, "ingest <id>", "Bulut çalışanının list_events çıktısındaki [VLAD:*] işaretlerini görev dosyasına işler (idempotent)", (id: string, o: Opts) => {
  const parsed = parseEvents(readInput(((o.eventsFile ?? o.file) as string | undefined) ?? "-"));
  const r = ingestEvents(id, eventList(parsed), { head: o.remoteHead as string | undefined, warnings: pageWarnings(parsed) });
  out(o, r, [
    `${r.processed.length} işaret işlendi, ${r.skipped.length} zaten işlenmişti`,
    ...r.warnings.map((w) => `uyarı: ${w}`),
  ].join("\n"));
})
  .option("--events-file <yol>", "list_events çıktısı: JSON veya JSONL (- veya yok = stdin)")
  .option("--file <json>", "--events-file takma adı")
  .option("--remote-head <sha>", "vlad/<id> ucunun sha'sı (git ls-remote yerine; ör. GitHub'dan)");

def(task, "log <id> <mesaj>", "## İlerleme'ye zaman damgalı satır ekler", (id: string, msg: string, o: Opts) => {
  logTask(id, msg);
  out(o, { id }, "eklendi");
});
def(task, "ask <id> <soru>", "Soru ekler, blocked yapar", (id: string, q: string, o: Opts) => {
  const t = askTask(id, q);
  out(o, { id, state: t.data.state }, `${id} -> ${t.data.state}`);
});
def(task, "answer <id> <cevap>", "Cevabı ekler, running yapar", (id: string, a: string, o: Opts) => {
  const t = answerTask(id, a);
  out(o, { id, state: t.data.state }, `${id} -> ${t.data.state}`);
});
def(task, "report <id>", "Kapanış raporunu yazar, awaiting_approval yapar", (id: string, o: Opts) => {
  const md = readInput(o.file as string);
  const t = reportTask(id, md);
  const warnings = reportReferencesPrior(md)
    ? ["rapor önceki rapora atıf içeriyor (yerine geçer / üstüne ekler / aynen geçerli); tam metin olmalı. Önceki rapor '## Önceki raporlar'da saklandı"]
    : [];
  out(o, { id, state: t.data.state, warnings }, [`${id} -> ${t.data.state}`, ...warnings.map((w) => `uyarı: ${w}`)].join("\n"));
}).requiredOption("--file <md>", "rapor dosyası (- = stdin)");
def(task, "set <id> <state>", "Durum makinesine uygun geçiş", (id: string, state: string, o: Opts) => {
  if (!(state in TRANSITIONS)) throw new Error(`bilinmeyen durum: ${state}; geçerliler: ${Object.keys(TRANSITIONS).join(", ")}`);
  if (o.reason !== undefined && state !== "cancelled") throw new Error("--reason yalnızca cancelled için");
  const t = state === "cancelled" ? cancelTask(id, String(o.reason ?? "")) : setState(id, state as TaskState);
  out(o, { id, state: t.data.state }, `${id} -> ${t.data.state}`);
}).option("--reason <metin>", "iptal gerekçesi (cancelled için zorunlu; İlerleme'ye 'İptal: <metin>' yazılır)");
def(task, "deps <id>", "queued pipeline fazının bağımlılıklarını değiştirir (tam olarak bir mod)", (id: string, o: Opts) => {
  const ids = (v: unknown) => (v === undefined ? undefined : String(v).split(",").map((x) => x.trim()).filter(Boolean));
  const r = setDependencies(id, { set: ids(o.set), add: ids(o.add), remove: ids(o.remove), clear: o.clear ? true : undefined });
  const dependsOn = r.task.data.depends_on ?? [];
  const satisfied = unmetDependencies(r.task).length === 0;
  out(o, { id, previous: r.previous, depends_on: dependsOn, changed: r.changed, dependencies_satisfied: satisfied, warnings: r.warnings },
    [`${id} bağımlılık: ${dependsOn.join(",") || "yok"} (önceki: ${r.previous.join(",") || "yok"})`,
      ...r.warnings.map((w) => `uyarı: ${w}`)].join("\n"));
})
  .option("--set <ids>", "bağımlılıkları bu listeyle değiştir (virgülle ayrılmış)")
  .option("--add <ids>", "listeye ekle")
  .option("--remove <ids>", "listeden çıkar")
  .option("--clear", "tüm bağımlılıkları kaldır");
def(task, "resume <id>", "running/stalled görev için devam bilgisi (yerel: worktree kontrolü + prompt; bulut: send_message argümanları)", async (id: string, o: Opts) => {
  // --- machines:C1 --- hazırlık kilitli (kb yazar), worktree denetimi kilitsiz; uzak makinedeki görev C2'de
  const cfg0 = loadConfig();
  const { plan, remote } = await withKbLock(() => ({ remote: remoteMachineOf(getTask(id), cfg0), plan: resumePrepare(id) }));
  if (remote) {
    // uzak görev: worktree denetimi ve yeniden başlatma işçide (Agent), kb kilidi dışında
    if (o.external) throw new Error("--external uzak makinede desteklenmez");
    const transport = brainTransport(cfg0, selfName());
    await syncKb(transport, remote); // the worker reads the task file from its kb clone
    const rr = await remoteResume(transport, remote, getTask(id), plan, cfg0);
    out(o, { id, mode: "remote", machine: remote, ...rr }, `${id} ${remote} makinesinde sürdürüldü (${rr.method}) -> ${rr.worktree}${rr.dirty.length ? `\nkaydedilmemiş: ${rr.dirty.join(", ")}` : ""}`);
    return;
  }
  const r = resumeLocalCheck(plan);
  // --- /machines:C1 ---
  // the trust record may be gone (cleanup, a rewritten ~/.claude.json): without it the resumed worker stops at the trust screen (F-vlad-081)
  const trustWarn = r.mode === "local" ? trustWorktree(r.worktree) : null;
  if (trustWarn) process.stderr.write(`uyarı: ${trustWarn}\n`);
  const rq: { dir: string | null; warning?: string } = o.external || r.mode !== "local" ? { dir: null as string | null } : desktopQueueDir();
  if ("warning" in rq && rq.warning) process.stderr.write(`uyarı: ${rq.warning}\n`);
  if (o.external || rq.dir) {
    if (r.mode !== "local") throw new Error("--external yerel çalışan içindir; bulut görevi için --external kullanılamaz");
    const t = getTask(id);
    const model = modelInfo(t.data).effective_model;
    const autoCompact = loadConfig().workerAutoCompact;
    const sid = t.data.session_id?.trim() || soleTranscriptSession(r.worktree);
    if (rq.dir) {
      try { secureDir(join(tmpdir(), "vlad")); } catch (e) {
        process.stderr.write(`uyarı: betik klasörü korunamadı (${(e as Error).message}); kuyruk yazılamadı, devam bilgisi yazdırılıyor
`);
        rq.dir = null;
      }
    }
    const ext = externalLaunch({
      taskId: id, cwd: r.worktree, prompt: r.prompt, env: { VLAD_TASK_ID: id, VLAD_HOME: kbPaths().home },
      title: `VLAD ${id} — ${t.data.title}`, ...(model ? { model } : {}),
      ...(autoCompact ? { autoCompact } : {}),
      // keep the worker's context. No recorded session: only the worktree's single transcript is safe to resume; `--continue` could pick any session (F-vlad-097), so otherwise start fresh (the prompt carries the log tail)
      ...(sid ? { resume: { sessionId: sid } } : {}),
    });
    if (!ext.ok) throw new Error(`betik yazılamadı: ${ext.detail}`);
    if (o.external || !rq.dir) {
      out(o, { ...r, script: ext.script, command: ext.command, cwd: ext.cwd }, `${ext.script}\n${ext.command}`);
      return;
    }
    try {
      const queued = enqueueDesktop(rq.dir, { kind: "resume", taskId: id, script: ext.script!, cwd: ext.cwd! });
      out(o, { ...r, method: "desktop-queue", queued, script: ext.script, cwd: ext.cwd }, `${id} vlad-desktop kuyruğuna yazıldı: ${queued}`);
      return;
    } catch (e) {
      process.stderr.write(`uyarı: kuyruk yazılamadı (${(e as Error).message}); devam bilgisi yazdırılıyor\n`); // falls through to the plain resume output
    }
  }
  out(o, r, r.mode === "local"
    ? `${r.prompt}${r.dirty.length ? `\nkaydedilmemiş: ${r.dirty.join(", ")}` : ""}`
    : `send_message session_id=${r.session_id}\n${r.message}`);
}).option("--external", "yerel çalışan için betik yaz (terminal açma); script/command/cwd döner");
def(task, "close-window <id>", "Görevin çalışan penceresini/süreç ağacını kapatır; durum ve worktree değişmez", async (id: string, o: Opts) => {
  const cfg0 = loadConfig();
  const remote = remoteMachineOf(getTask(id), cfg0, workerContext()?.self); // işçide kendi görevi yerel kapanır (F-vlad-149)
  const r = remote ? { id, killed: await remoteClose(brainTransport(cfg0, selfName()), remote, id) } : closeTaskWindow(id);
  out(o, r, r.killed.length ? `${id} penceresi kapatıldı (pid: ${r.killed.join(", ")})` : `${id} için açık pencere yok`);
});
def(task, "cleanup <id>", "done/cancelled görevin çalışan penceresini kapatır ve worktree'sini kaldırır", async (id: string, o: Opts) => {
  // --- machines:C1 --- kb yazan cleanup kilitli; uzak makinedeki görevin worktree'si burada yok (C2)
  const cfg0 = loadConfig();
  const remote = await withKbLock(() => {
    const t = getTask(id);
    const m = remoteMachineOf(t, cfg0);
    if (m) {
      if (t.data.state !== "done" && t.data.state !== "cancelled") throw new Error(`cleanup yalnızca done/cancelled görevde yapılır (${t.data.state}): ${id}`);
      return m;
    }
    cleanupTask(id, { cfg: cfg0 });
    return null;
  });
  if (remote) {
    // ağ çağrısı kb kilidi dışında; kilit yalnız `worktree: null` yazısı için
    await remoteCleanup(brainTransport(cfg0, selfName()), remote, getTask(id));
    await withKbLock(() => markCleaned(id));
  }
  // --- /machines:C1 ---
  out(o, { id }, `${id} worktree kaldırıldı`);
});
// --- machines:C4 --- uzak makinedeki görev/çatı için kapı işlemleri (push yok); yerel görevde /integrate akışı geçerli
async function gateRoute(id: string): Promise<{ machine: string; transport: ReturnType<typeof brainTransport> }> {
  const cfg0 = loadConfig();
  const machine = gateMachineOf(getTask(id), cfg0);
  if (!machine) throw new Error(`${id} uzak makinede değil; kapı işlemleri yerelde /integrate akışıyla yapılır`);
  const transport = brainTransport(cfg0, selfName());
  await syncKb(transport, machine); // işçi kartın gate'ini ve görev dosyasını kendi kb klonundan okur
  return { machine, transport };
}
def(task, "gate <id>", "Uzak makinede kartın gate komutunu koşar (--target integration: çatı worktree'si, task: görevin kendisi); gate kırmızıysa çıkış 1", async (id: string, o: Opts) => {
  const target = (o.target ?? defaultGateTarget(getTask(id))) as string;
  if (target !== "integration" && target !== "task") throw new Error("--target integration | task olmalı");
  const { machine, transport } = await gateRoute(id);
  const r = await remoteGateRun(transport, machine, getTask(id), target);
  await withKbLock(() => recordGreenGate(id, r, target));
  out(o, { id, machine, target, ...r }, `${r.stdout}${r.stderr ? `
${r.stderr}` : ""}
[gate çıkış kodu ${r.exit}]`);
  if (r.exit !== 0) process.exitCode = 1;
}).option("--target <hedef>", "integration (çatı için varsayılan) | task (dev görevi için varsayılan)");
def(task, "merge-preview <id>", "Uzak makinede merge önizlemesi: log, diff --stat, çakışmalar (yazmaz)", async (id: string, o: Opts) => {
  const { machine, transport } = await gateRoute(id);
  const r = await remoteMergePreview(transport, machine, getTask(id), { ...(o.into ? { into: o.into as string } : {}) });
  out(o, { id, machine, ...r }, `${r.log}${r.diffStat}${r.conflicts.length ? `çakışma: ${r.conflicts.join(", ")}` : "çakışma yok"}`);
}).option("--into <dal>", "hedef dal (varsayılan: vlad/<çatı> ya da kartın default_branch'i)");
def(task, "merge <id>", "Uzak makinede görev dalını hedefe --no-ff merge eder (push yok; çakışmada geri alınır)", async (id: string, o: Opts) => {
  const { machine, transport } = await gateRoute(id);
  const r = await remoteMerge(transport, machine, getTask(id), { ...(o.into ? { into: o.into as string } : {}), ...(o.message ? { message: o.message as string } : {}) });
  out(o, { id, machine, ...r }, r.merged ? `${id} merge edildi -> ${r.head}` : `${id} zaten içeride (${r.head})`);
}).option("--into <dal>", "hedef dal (varsayılan: vlad/<çatı> ya da kartın default_branch'i)").option("--message <metin>", "merge commit mesajı");
// --- /machines:C4 ---
def(task, "digested <ids...>", "done görevlerin kapanış raporunu /digest'te işlenmiş olarak işaretler", (ids: string[], o: Opts) => {
  markDigested(ids);
  out(o, { ids }, `${ids.length} görev işlendi olarak işaretlendi`);
});
def(task, "session <id> <session_id>", "Görevin session_id alanını yazar (durum değişmez)", (id: string, sessionId: string, o: Opts) => {
  if (!sessionId.trim()) throw new Error("session_id boş olamaz");
  const t = getTask(id);
  t.data.session_id = sessionId.trim();
  saveTask(t);
  out(o, { id, session_id: t.data.session_id }, `${id} session_id: ${t.data.session_id}`);
});
def(task, "list", "Görevleri listeler", (o: Opts) => {
  const states = o.undigested ? ["done" as TaskState] : o.state ? String(o.state).split(",") as TaskState[] : undefined;
  const listed = listTasksWithWarnings({ state: states, project: o.project as string | undefined, parent: o.parent as string | undefined });
  const tasks = o.undigested ? listed.tasks.filter((t) => !t.data.digested) : listed.tasks;
  const { warnings } = listed;
  const limit = o.limit === undefined ? undefined : Number(o.limit);
  if (limit !== undefined && !(limit >= 1)) throw new Error(`geçersiz --limit: ${o.limit}`);
  const shown = limit === undefined ? tasks : tasks.slice(-limit); // ids are date-ordered: the newest N
  const fields = o.fields ? String(o.fields).split(",").map((f) => f.trim()).filter(Boolean) : undefined;
  let rows: unknown[];
  if (fields) {
    const bad = fields.filter((f) => !DERIVED_FIELDS.includes(f) && !TASK_FIELDS.includes(f));
    if (bad.length) throw new Error(`bilinmeyen alan: ${bad.join(", ")}`);
    const all = fields.includes("integration_worktrees") ? listTasksWithWarnings().tasks : undefined;
    rows = shown.map((t) => {
      const full: Record<string, unknown> = { ...t.data };
      if (fields.includes("role_model") || fields.includes("effective_model")) Object.assign(full, modelInfo(t.data));
      if (fields.includes("integration_worktrees")) Object.assign(full, integrationInfo(t, all));
      return Object.fromEntries(fields.filter((f) => f in full).map((f) => [f, full[f]]));
    });
  } else {
    const all = shown.some((t) => t.data.kind === "pipeline") ? listTasksWithWarnings().tasks : undefined;
    rows = shown.map((t) => withModel(t, all));
  }
  out(
    o,
    { tasks: rows, warnings },
    [...shown.map(taskLine), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
  );
})
  .option("--state <states>", "virgülle ayrılmış durumlar")
  .option("--project <slug>", "proje slug'ı")
  .option("--undigested", "yalnızca kapanış raporu /digest'te işlenmemiş done görevler")
  .option("--parent <id>", "yalnızca bu pipeline'ın fazları")
  .option("--fields <alanlar>", "--json çıktısını bu alanlarla sınırla (virgülle; role_model, effective_model, integration_worktrees yalnız istenirse hesaplanır)")
  .option("--limit <n>", "en yeni n görev");
def(task, "idle", "Uzun süredir güncellenmeyen running/blocked görevler (bekçi modu dürtmesi için)", (o: Opts) => {
  const minutes = Number(o.minutes);
  if (!(minutes >= 0)) throw new Error(`geçersiz --minutes: ${o.minutes}`);
  const tasks = idleTasks(new Date(), minutes);
  out(o, { minutes, tasks }, tasks.map((t) => `${t.id}  ${t.state.padEnd(8)} ${t.idle_minutes} dk  ${t.branch ?? "-"}  ${t.last_log ?? ""}`).join("\n"));
}).option("--minutes <n>", "en az bu kadar dakikadır sessiz", "30");
// --- machines:A ---
def(task, "ready", "Başlatılmaya hazır görevler (queued, bağımlılıkları done)", (o: Opts) => {
  const cfg = loadConfig();
  const r = readyWithLimit({ parent: o.parent as string | undefined }, cfg.maxParallel, cfg);
  for (const w of r.warnings ?? []) process.stderr.write(`uyarı: ${w}\n`);
  const why = (id: string) => (r.held_reasons?.find((h) => h.id === id)?.reasons ?? []).map((x) => `${x.machine} ${x.reason}`).join(", ");
  const lines = [
    ...r.tasks.map((t) => taskLine(t) + (r.placements ? `  -> ${r.placements.find((p) => p.id === t.data.id)?.machine}` : "")),
    ...r.held_by_limit.map((t) => `${taskLine(t)}  (${r.held_reasons ? `bekliyor: ${why(t.data.id)}` : `maxParallel dolu: ${r.running}/${r.maxParallel}, bekliyor`})`),
  ];
  out(
    o,
    {
      tasks: r.tasks.map((t) => t.data), held_by_limit: r.held_by_limit.map((t) => t.data), running: r.running, maxParallel: r.maxParallel,
      ...(r.placements ? { placements: r.placements, held_reasons: r.held_reasons, warnings: r.warnings } : {}),
    },
    lines.join("\n"),
  );
}).option("--parent <id>", "yalnızca bu pipeline'ın fazları");
// --- /machines:A ---

def(program, "status", "Aktif görevler; eski running görevleri stalled yapar", (o: Opts) => {
  const s = statusSummary(loadConfig(), new Date(), undefined, undefined, { mark: o.mark !== false, remotePlans: o.remotePlans as RemoteStallPlan[] | undefined });
  if (o.summary) {
    // "rapor" covers inbox records and closing reports of done tasks that /digest has not processed
    const line =
      `İşlenmemiş ${s.inbox + s.undigested} rapor, ${s.active.length} aktif görev ` +
      `(${s.counts.awaiting_approval} onay bekliyor, ${s.counts.stalled} takıldı, ${s.counts.blocked} soru soruyor, ${s.failed.length} hatalı)` +
      (s.staleSummaries.length ? `, ${s.staleSummaries.length} bayat/eksik proje özeti: ${staleSummaryText(s.staleSummaries)}` : "") +
      (s.pendingDigest ? `, ${s.pendingDigest} onay bekleyen digest maddesi` : "") +
      (s.openSevereFindings ? `, ${s.openSevereFindings} açık kritik/yüksek bulgu` : "") +
      (s.kbLint.count ? `, ${s.kbLint.count} kb çelişkisi${lintAgeNote(s.kbLint)}` : "") +
      (s.mode ? `; ${s.mode}` : "");
    if (o.hook) {
      // SessionStart hook JSON: systemMessage kullanıcıya görünür, additionalContext modelin bağlamına girer.
      process.stdout.write(JSON.stringify({
        systemMessage: `VLAD: ${line}`,
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line },
      }) + "\n");
      return;
    }
    out(o, { ...s, active: s.active.map((t) => t.data), failed: s.failed.map((t) => t.data), summary: line }, line);
    return;
  }
  const lines = [...s.active.map(statusLine), `inbox: ${s.inbox}`];
  if (s.mode) lines.push(`mod: ${s.mode}`);
  if (s.newlyStalled.length) lines.push(`takıldı: ${s.newlyStalled.join(", ")}`);
  if (s.failed.length) lines.push(`hatalı: ${s.failed.map((t) => t.data.id).join(", ")}`);
  out(o, { ...s, active: s.active.map((t) => withModel(t)), failed: s.failed.map((t) => t.data) }, lines.join("\n"));
}).option("--summary", "tek satır özet")
  .option("--no-mark", "yan etkisiz okuma: stalled işaretleme ve mod penceresi temizliği yapılmaz (aynı JSON şekli)")
  .option("--hook", "--summary ile: SessionStart hook JSON'u (systemMessage + additionalContext)");

const mode = program.command("mode").description("Gece / bekçi modu (yetki penceresi kb/mode.json)");
const modeText = (now: Date) => modeLine(now) ?? "mod kapalı";
def(mode, "night", "Gece (yetki) modunu açar: pencere boyunca faz ve son kapı merge'ü sormadan", (o: Opts) => {
  const night = setNight({
    until: o.until as string, note: o.note as string | undefined,
    projects: o.projects ? String(o.projects).split(",").map((x) => x.trim()).filter(Boolean) : undefined,
  });
  out(o, { night }, modeText(new Date()));
})
  .requiredOption("--until <HH:MM|ISO>", "bitiş: sıradaki HH:MM ya da ISO tarih-saat (en çok 24 saat)")
  .option("--projects <a,b>", "yetkinin geçtiği projeler (boş = hepsi)")
  .option("--note <metin>", "kullanıcının verdiği kapsam notu");
def(mode, "watch <on|off>", "Bekçi modu: gece modundan bağımsız aç/kapat", (v: string, o: Opts) => {
  if (v !== "on" && v !== "off") throw new Error("on ya da off ver");
  setWatch(v === "on");
  out(o, modeStatus(new Date()), modeText(new Date()));
});
def(mode, "off", "Gece ve bekçi modunu kapatır", (o: Opts) => {
  setOff();
  out(o, modeStatus(new Date()), "mod kapalı");
});
def(mode, "status", "Mod durumu (biten pencere bir kez bildirilir, sonra temizlenir)", (o: Opts) => {
  const now = new Date();
  const s = modeStatus(now);
  const line = modeText(now);
  expireMode(now);
  out(o, { ...s, line }, line);
});

const audit = program.command("audit").description("Denetimler");
def(audit, "skills", "Görev oturum kayıtlarından beklenen/yüklenen/eksik skill denetimi", (o: Opts) => {
  const r = auditSkills({ since: o.since as string | undefined, project: o.project as string | undefined });
  const lines = r.tasks.map((t) => t.transcript
    ? `${t.id}  ${t.project}  ${t.loaded.length}/${t.expected.length}${t.missing.length ? `  eksik: ${t.missing.join(", ")}` : ""}`
    : `${t.id}  ${t.project}  (oturum kaydı yok)`);
  const vl = Object.entries(r.vlad.loaded).map(([k, v]) => `${k}×${v}`).join(", ") || "-";
  lines.push(`VLAD: yüklenen ${vl}${r.vlad.missing.length ? `; eksik: ${r.vlad.missing.join(", ")}` : ""}`);
  const { summary: m } = r;
  lines.push(`özet: ${m.audited}/${m.tasks} görevin kaydı var, ${m.loaded}/${m.expected} beklenen skill yüklendi${m.rate === null ? "" : ` (%${Math.round(m.rate * 100)})`}`);
  out(o, r, lines.join("\n"));
})
  .option("--since <tarih>", "bu tarihten sonra oluşturulan görevler")
  .option("--project <slug>", "yalnızca bu proje");

def(audit, "setup", "Kurulum denetimi verisi (salt okuma): biten görevler, ölçümler, sürtünme işaretleri, skill envanteri, yaşlı bulgular", (o: Opts) => {
  const r = auditSetup({ since: o.since as string | undefined });
  const sev = Object.entries(r.open_points.by_severity).map(([k, v]) => `${k}:${v}`).join(" ") || "-";
  const sg = r.signals;
  out(o, r, [
    `aralık: ${r.since} → ${r.tasks.total} biten görev`,
    `ölçüm: ${r.measures.tasks_with_measure} görevde; ${Object.entries(r.measures.sums).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`,
    ...(r.measures.by_ponytail.on.tasks + r.measures.by_ponytail.off.tasks ? [`ponytail A/B: ` + (['on', 'off'] as const).map((k) => `${k} ${r.measures.by_ponytail[k].tasks} görev (${r.measures.by_ponytail[k].tasks_with_measure} ölçümlü; ${Object.entries(r.measures.by_ponytail[k].sums).map(([n, v]) => `${n}=${v}`).join(' ') || '-'})`).join(' | ')] : []),
    `açık nokta: ${r.open_points.total} (${sev})`,
    `işaretler: test itirazı ${sg.test_itirazi.count}, değişiklik turu ${sg.degisiklik_istegi.count}, [KARAR] ${sg.karar.count}, izin reddi ${sg.izin_reddi.count}, Codex turu ara ${sg.codex_turlari.ara}/son ${sg.codex_turlari.son} (${sg.codex_turlari.tasks} çatıda ölçüm)`,
    `skill: ${r.skills.inventory.length} envanterde, ${r.skills.unused.length} hiç yüklenmemiş (${r.skills.transcripts} oturum kaydı); rol skill oranı ${r.skills.coverage.rate === null ? "-" : `%${Math.round(r.skills.coverage.rate * 100)} (${r.skills.coverage.loaded}/${r.skills.coverage.expected}, kuraldan önceki ${r.skills.coverage.skipped_before_rule} atlandı)`}`,
    `iptal: ${r.cancelled.total} görev, ${r.cancelled.with_reason} gerekçeli`,
    `bulgu: ${r.findings.unresolved.length} açık/ertelenmiş, ${r.findings.stale} tanesi 30 günden eski`,
  ].join("\n"));
}).option("--since <tarih>", "bu tarihten sonra biten görevler (YYYY-MM-DD; varsayılan: 14 gün önce)");

const inbox = program.command("inbox").description("Oturum raporları");
def(inbox, "list", "İşlenmemiş raporlar", (o: Opts) => {
  const { items, warnings } = listInboxWithWarnings();
  out(
    o,
    { items, warnings },
    [...items.map((i) => `${i.file}  ${i.record.project ?? "-"}  ${i.record.reason}`), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
  );
});
def(inbox, "count", "İşlenmemiş rapor sayısı", (o: Opts) => {
  const count = listInboxWithWarnings().items.length;
  out(o, { count }, String(count));
});
def(inbox, "done <dosyalar...>", "Raporları processed/'a taşır", (files: string[], o: Opts) => {
  markDone(files);
  out(o, { moved: files }, `${files.length} rapor taşındı`);
});

const digestCmd = program.command("digest").description("Digest yardımcıları");
const pendingCmd = digestCmd.command("pending").description("Onay bekleyen digest maddeleri (otomatik digest, D-vlad-061)");
const pendingLine = (i: { id: string; state: string; task: string | null; project: string | null; text: string }) =>
  `${i.id}  ${i.state}  ${i.project ?? "-"}  ${i.task ?? "-"}  ${i.text}`;
def(pendingCmd, "add", "Kullanıcı onayı bekleyen digest maddesi ekler", (o: Opts) => {
  const i = addPending({ text: o.text as string, task: o.task as string | undefined, project: o.project as string | undefined });
  out(o, { id: i.id, item: i }, i.id);
})
  .requiredOption("--text <metin>", "madde metni")
  .option("--task <id>", "ilgili görev ID'si")
  .option("--project <slug>", "ilgili proje");
def(pendingCmd, "list", "Açık maddeleri listeler (--all: kapalılar dahil)", (o: Opts) => {
  const items = listPending(o.all === true);
  out(o, { items }, items.map(pendingLine).join("\n"));
}).option("--all", "kapalı maddeleri de göster");
def(pendingCmd, "done <id>", "Maddeyi kapatır (kullanıcı karar verdi / işlendi)", (id: string, o: Opts) => {
  const i = donePending(id, o.note as string | undefined);
  out(o, { item: i }, `${i.id} kapatıldı`);
}).option("--note <metin>", "kapanış notu (karar/sonuç)");

const decision = program.command("decision").description("Karar günlüğü");
def(decision, "add", "kb/decisions/<proje>.md'ye karar ekler; D-<proje>-NNN ID'si döner", (o: Opts) => {
  const id = addDecision({
    project: o.project as string,
    title: o.title as string,
    body: readInput(o.bodyFile as string),
    source: o.source as string | undefined,
    supersedes: o.supersedes as string | undefined,
    until: o.until as string | undefined,
  });
  out(o, { ok: true, id }, `karar eklendi: ${id}`);
})
  .requiredOption("--project <slug>", "proje")
  .requiredOption("--title <başlık>", "başlık")
  .requiredOption("--body-file <md>", "gövde (- = stdin)")
  .option("--source <kaynak>", "session/görev kaynağı")
  .option("--supersedes <id>", "bu kararın yerine geçtiği karar (o yerine-geçti olur)")
  .option("--until <tarih>", "kararın son tarihi (YYYY-MM-DD ya da YYYY-MM-DDTHH:MM); geçince status/kb lint süresi dolmuş geçerli karar olarak işaretler");
def(decision, "list", "Kararları kısa listeler (varsayılan yalnız geçerli)", (o: Opts) => {
  const decisions = listDecisions({ project: o.project as string | undefined, all: !!o.all }).map(({ path: _p, ...d }) => d); // paths are for `kb search`; they only bloat a list
  out(o, { decisions }, decisions.map((d) => `${d.id}  ${d.date}  ${d.status}  ${d.title}${d.superseded_by ? `  -> ${d.superseded_by}` : ""}${d.until ? `  (süre: ${d.until}${isDecisionExpired(d) ? ", doldu" : ""})` : ""}`).join("\n"));
})
  .option("--project <slug>", "yalnız bu proje (genel kararlar: genel)")
  .option("--all", "geçersiz ve yerine geçilmiş kararlar da");
def(decision, "set <id> <durum>", `Kararın durumunu değiştirir (${DECISION_STATUSES.join(" | ")})`, (id: string, status: string, o: Opts) => {
  setDecisionStatus(id, status, o.supersededBy as string | undefined);
  out(o, { id, status, superseded_by: (o.supersededBy as string | undefined) ?? null }, `${id} -> ${status}`);
}).option("--superseded-by <id>", "yerine geçen karar (yerine-geçti için zorunlu)");
def(decision, "migrate", "ID'siz eski karar bloklarına D-<proje>-NNN ve durum 'geçerli' ekler (metin silinmez, idempotent)", (o: Opts) => {
  const r = migrateDecisions({ dryRun: !!o.dryRun });
  const verb = o.dryRun ? "verilecek" : "verildi";
  out(o, { dry_run: !!o.dryRun, files: r }, r.length ? [...(o.dryRun ? ["DRY-RUN: hiçbir dosya değişmedi"] : []), ...r.map((f) => `decisions/${f.file}.md: ${f.assigned} ID ${verb}`)].join("\n") : "geçiş gerekmiyor");
}).option("--dry-run", "hiçbir şeye dokunmadan göster");

const journal = program.command("journal").description("Günlük");
def(journal, "append <tarih>", "kb/journal/<tarih>.md'ye ekler", (date: string, o: Opts) => {
  appendJournal(date, readInput(o.file as string));
  out(o, { date }, `günlüğe eklendi: ${date}`);
}).requiredOption("--file <md>", "içerik (- = stdin)");

def(journal, "get <tarih>", "kb/journal/<tarih>.md içeriğini proje bölümleriyle döner (salt okuma)", (date: string, o: Opts) => {
  const j = getJournal(date);
  out(o, j, j.content);
});

const kb = program.command("kb").description("Hafıza deposu");
def(kb, "commit <mesaj>", "kb/ altındaki değişiklikleri `kb: <mesaj>` olarak commit'ler (kod dahil edilmez)", (msg: string, o: Opts) => {
  const r = commitKb(msg, { push: !!o.push });
  const lines = [r.committed ? `commit: ${r.sha}` : "kb'de değişiklik yok"];
  if (r.pushed) lines.push("push edildi");
  if (r.warning) lines.push(`uyarı: ${r.warning}`);
  out(o, r, lines.join("\n"));
}).option("--push", "upstream'e push eder (yalnızca push edilmemiş commit'lerin hepsi kb/ ise)");
def(kb, "maintain", "kb bakımı: decisions.md'yi projelere böler, eski kapalı görev/bulguları archive/'e taşır (silme yok)", (o: Opts) => {
  const days = o.days === undefined ? undefined : Number(o.days);
  if (days !== undefined && !(days >= 0)) throw new Error(`geçersiz --days: ${o.days}`);
  const r = maintainKb({ days, dryRun: !!o.dryRun });
  const verb = r.dry_run ? "taşınacak" : "taşındı";
  const lines = [
    ...(r.dry_run ? ["DRY-RUN: hiçbir dosya değişmedi"] : []),
    ...r.decisions.map((d) => `karar: decisions/${d.file}.md ← ${d.blocks} blok`),
    ...r.tasks.map((t) => `görev ${verb}: ${t.from} -> ${t.to}`),
    ...r.findings.map((f) => `bulgu ${verb}: ${f.from} -> ${f.to}`),
    ...r.gitignore_added.map((g) => `.gitignore: ${g} eklen${r.dry_run ? "ecek" : "di"}`),
  ];
  out(o, r, lines.length ? lines.join("\n") : "yapılacak bakım yok");
}).option("--days <n>", "bu kadar günden eski kapalı kayıtlar arşivlenir (varsayılan 30)")
  .option("--dry-run", "hiçbir şeye dokunmadan yapılacakları göster");
def(kb, "get <id>", "Görev (T…) ya da bulguyu (F-…) ID ile okur; arşivdekini de bulur, gerçek yolu verir", (id: string, o: Opts) => {
  const r = getKbRecord(id, o.section as string | undefined);
  out(o, r, `${r.file}${r.archived ? " (arşiv)" : ""}\n\n${r.content}`);
}).option("--section <başlık>", "yalnız bu `## ` bölümünü döndür (ör. \"## Kapanış raporu\")");
def(kb, "search <sorgu>", "Sınırlı kb araması (görev bölümü, bulgu, karar bloğu, günlük bölümü; arşiv dahil); tüm kelimeler geçmeli", (query: string, o: Opts) => {
  const hits = searchKb({ query, project: o.project as string | undefined, type: o.type as string | undefined, limit: o.limit === undefined ? undefined : Number(o.limit) });
  out(o, { hits }, hits.map((h) => `${h.id}  ${h.type}  ${h.status ?? "-"}  ${h.date ?? "-"}${h.section ? `  ${h.section}` : ""}\n  ${h.snippet}\n  ${h.path}`).join("\n") || "eşleşme yok");
})
  .option("--project <slug>", "yalnız bu proje")
  .option("--type <tür>", "task | finding | decision | journal")
  .option("--limit <n>", "en çok bu kadar sonuç", "8");
def(kb, "refs <id>", "ID'ye (T…, F-…, D-…) atıf yapan kayıtları bölüm/durum/tarihle, ilgili commit'leri ve çelişki işaretlerini listeler", (id: string, o: Opts) => {
  const r = refsOf(id);
  out(o, r, formatRefs(r));
});
def(kb, "lint", "Salt okuma çelişki denetimi: kart/karar/hafıza metinlerindeki T…/F-…/D-… atıflarını gerçek kayıtla karşılaştırır (işaret varsa 0, --strict'te 1)", (o: Opts) => {
  const r = lintKb({ project: o.project as string | undefined });
  if (!o.project) writeLintCache(r); // a whole-kb run feeds `status --summary` (kbLint)
  out(o, r, formatLint(r));
  process.exitCode = lintExitCode(r, !!o.strict);
}).option("--project <slug>", "yalnız bu proje")
  .option("--strict", "işaret varsa 1 ile çık");
def(kb, "check", "kb remote'unda `kb:` öneki taşımayan (yabancı) ve CLAUDE.md/.claude/.github'a dokunan commit'leri listeler", (o: Opts) => {
  const r = checkKb({ ack: o.ack as string | undefined });
  const lines = r.foreign.length
    ? [`yabancı commit: ${r.foreign.length}`, ...r.foreign.map((c) => `${c.sha} ${c.author}: ${c.subject}`)]
    : ["yabancı commit yok"];
  if (r.suspicious.length) lines.push(`şüpheli dosya değişikliği: ${r.suspicious.length}`, ...r.suspicious.map((c) => `${c.sha} ${c.author}: ${c.subject} [${c.files.join(", ")}]`));
  for (const w of r.warnings ?? []) lines.push(`uyarı: ${w}`);
  out(o, r, lines.join("\n"));
  process.exitCode = kbCheckExitCode(r, !!o.strict);
}).option("--ack <sha>", "görüldü say: doğrulanan noktayı `check` çıktısındaki head'e ilerletir (sonradan gelenler işaretlenmez)")
  .option("--strict", "yabancı/şüpheli commit varsa ya da kontrol yapılamadıysa 1 ile çık");

const sessionFile = () => join(kbPaths().kb, "vlad-session.txt");
const session = program.command("session").description("VLAD oturum adı");
def(session, "register <ad>", "Oturum adını kb/vlad-session.txt'ye yazar", (name: string, o: Opts) => {
  if (!name.trim()) throw new Error("oturum adı boş olamaz");
  const file = sessionFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, name.trim() + "\n");
  out(o, { name: name.trim() }, `kaydedildi: ${name.trim()}`);
});
def(session, "name", "Kayıtlı oturum adını yazar", (o: Opts) => {
  const file = sessionFile();
  if (!existsSync(file)) throw new Error("oturum kaydı yok; önce `vlad session register <ad>`");
  const name = readFileSync(file, "utf8").trim();
  out(o, { name }, name);
});

// --- machines:B --- agent, queue, remote
const agent = program.command("agent").description("VLAD Agent (çoklu makine; T20261101-19)");
def(agent, "start", "Agent'ı başlatır (tek örnek; kimlik VLAD_MACHINE/vlad.local.json)", async (o: Opts) => {
  await agentStart({ port: o.port === undefined ? undefined : Number(o.port), printPort: !!o.printPort });
}).option("--port <n>", "config portunu geçersiz kıl (0 = rastgele)").option("--print-port", "ilk stdout satırı {\"listening\":{host,port}}");
def(agent, "status", "Yerel Agent çalışıyor mu", async (o: Opts) => {
  const s = await agentStatus();
  out(o, s, s.running ? `çalışıyor: ${s.host}:${s.port}${s.pid ? ` (pid ${s.pid})` : ""}` : `çalışmıyor (${s.host}:${s.port})`);
  process.exitCode = s.running ? 0 : 1;
});
def(agent, "keygen <kimlik>", "Anahtar üretir, vlad.local.json'a yazar (anahtarı basmaz; --show ile basar). <karşı-taraf> = çift anahtar (yalnız bu iki makine bilir; karşı uçta `setkey <ad> -` çalıştır); <kendi-adın> = yerel çağrı anahtarı", (identity: string, o: Opts) => {
  const r = agentKeygen(identity, !!o.show);
  const shown = r.key ? `${r.identity}: ${r.key}
` : `${r.identity}: anahtar üretildi (basmak için --show; yeniden üretmek eskisini değiştirir: bir kez --show ile bas, stdin'e ilet)
`;
  out(o, r, r.copy
    ? `${shown}(${r.file}'a yazıldı. Karşı uçta anahtarı stdin'den ver (argv'ye yazma):
  ${r.copy}
sonra iki ucun Agent'ını yeniden başlat)`
    : `${shown}(${r.file}'a yazıldı; yerel çağrı anahtarı, kopyalanmaz; Agent'ı yeniden başlat)`);
}).option("--show", "anahtarı çıktıya bas (varsayılan basmaz)");
def(agent, "setkey <karsi-taraf> <anahtar>", "Karşı uçta üretilmiş çift anahtarı yazar (keys.<karşı-taraf>); <anahtar> `-` olmalı, anahtar stdin'den okunur", (peer: string, key: string, o: Opts) => {
  if (key !== "-") throw new Error("agent setkey: anahtar argv'de verilmez (süreç listesine/kabuk geçmişine sızar); `-` ver ve anahtarı stdin'den ilet");
  const r = agentSetKey(peer, readInput("-").trim());
  out(o, r, `${r.peer} anahtarı ${r.file}'a yazıldı (Agent'ı yeniden başlat)`);
});

def(agent, "install", "Agent'ı oturum açılışında başlatacak kaydı basar (Mac: launchd plist, Windows: görev zamanlayıcı); --apply ile kurar", (o: Opts) => {
  const cfg = loadConfig();
  const self = selfName();
  const m = cfg.machines?.find((x) => x.name === self);
  if (!m) throw new Error(`agent install: ${self} config machines içinde değil`);
  const plan = installPlan(m.os, { node: process.execPath, cli: process.argv[1]!, home: getVladHome(), path: process.env.PATH ?? "" });
  if (o.apply) plan.apply?.();
  const text = [plan.description, ...(plan.file ? [`dosya: ${plan.file}`] : []), ...(plan.content ? ["", plan.content] : []), `komut: ${plan.command}`, ...(o.apply ? ["uygulandı"] : ["(uygulamak için --apply)"])].join("\n");
  out(o, { description: plan.description, file: plan.file, content: plan.content, command: plan.command, applied: !!o.apply }, text);
}).option("--apply", "kaydı gerçekten kur (yoksa yalnız basar)");

const queue = program.command("queue").description("İşçi tarafı beyin-yazma kuyruğu (yerel Agent'a sorar)");
const queueCall = async <T>(op: "queue-list" | "queue-flush" | "queue-drop", args: unknown): Promise<T> => {
  const w = workerContext();
  if (!w) throw new Error("queue: yalnız beyin olmayan işçi makinede kullanılır");
  return callLocal<T>(w.cfg, w.self, op, args);
};
def(queue, "list", "Bekleyen ve başarısız yazmalar", async (o: Opts) => {
  const r = await queueCall<{ entries: { seq: number; opId: string; cmd: string; id: string; state: string }[] }>("queue-list", {});
  out(o, r, r.entries.length ? r.entries.map((e) => `${e.seq}  ${e.state.padEnd(8)} ${e.cmd} ${e.id}  ${e.opId}`).join("\n") : "kuyruk boş");
});
def(queue, "flush", "Kuyruğu şimdi boşaltmayı dener", async (o: Opts) => {
  const r = await queueCall<{ sent: number; failed: number; remaining: number }>("queue-flush", {});
  out(o, r, `gönderilen ${r.sent}, başarısız ${r.failed}, kalan ${r.remaining}`);
});
def(queue, "drop <seq>", "Kuyruktaki (ya da başarısız) girdiyi siler", async (seq: string, o: Opts) => {
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 1) throw new Error(`seq geçersiz: ${seq}`);
  const r = await queueCall<{ dropped: true }>("queue-drop", { seq: n });
  out(o, r, `silindi: ${n}`);
});

program.command("remote").description("Konsol istemcisi: komutu beyin Agent'ında çalıştırır (vlad remote [--op-id id] [--stdin] -- <vlad argv…>)")
  .option("--op-id <uuid>", "yazma tekrarında ilk sonucu döndürmek için sabit opId").option("--stdin", "stdin'i komuta ilet (--file - için)")
  .argument("[argv...]").action(async (argv: string[], o: Opts) => {
    try { await runRemote(argv, { opId: o.opId as string | undefined, stdin: !!o.stdin }); } catch (e) { fail(e); }
  });
// --- /machines:B ---
// --- machines:C2 --- machine
const machine = program.command("machine").description("Makine kaydı ve uzak denetim");
const machineCfg = (): { cfg: VladConfig; self: string } => {
  const cfg = loadConfig();
  if (!cfg.machines) throw new Error("config'te machines tanımlı değil");
  return { cfg, self: selfName() };
};
def(machine, "list", "Config'teki makineler; brain'i ve yerel kimliği işaretler", (o: Opts) => {
  const { cfg, self } = machineCfg();
  const rows = cfg.machines!.map((m) => ({ name: m.name, os: m.os, brain: m.name === cfg.brain, self: m.name === self, host: m.agent.host ?? null, port: m.agent.port }));
  out(o, rows, rows.map((m) => `${m.name}  ${m.os}  ${m.host ?? "-"}:${m.port}${m.brain ? "  [brain]" : ""}${m.self ? "  [bu makine]" : ""}`).join("\n"));
});
def(machine, "ping <ad>", "Makinenin Agent'ına ping atar", async (name: string, o: Opts) => {
  const { cfg, self } = machineCfg();
  const t0 = Date.now();
  const r = (await brainTransport(cfg, self).call<{ machine: string; proto: number; build: string }>(name, "ping", {}, { timeoutMs: 10_000 })).result;
  out(o, { ...r, ms: Date.now() - t0 }, `${r.machine} yanıt verdi (proto ${r.proto}, build ${r.build}, ${Date.now() - t0} ms)`);
});
def(machine, "probe-window <ad>", "İşçide kısa ömürlü bir pencere açtırır (pencere görünüyor mu denemesi; Windows)", async (name: string, o: Opts) => {
  const { cfg, self } = machineCfg();
  const r = (await brainTransport(cfg, self).call<{ opened: boolean; method: string }>(name, "probe-window", {}, { timeoutMs: 30_000 })).result;
  out(o, r, `pencere açıldı (${r.method}); işçinin ekranında "VLAD probe-window" başlıklı pencere ~45 sn görünmeli`);
});
// --- /machines:C2 ---

// --- aktarim:S --- vlad send / vlad clip (ince kabuk; gövde src/transfer/cli.ts ve src/clip/cli.ts)
def(program, "send [yol...]", "Dosya/klasörleri karşı makinenin İndirilenler klasörüne gönderir (--to: makine; 2'den çok makinede zorunlu)", async (paths: string[], o: Opts) => {
  const { runSendCommand, argsFromEnv } = await import("./transfer/cli.js");
  if (o.argsEnv) paths = argsFromEnv(); else if (!paths?.length) throw new Error("gönderilecek yol verilmedi (<yol...> ya da --args-env)");
  await runSendCommand(paths, { to: o.to as string | undefined, json: !!o.json, notify: !!o.notify, isTTY: !!process.stderr.isTTY });
}).option("--to <makine>", "hedef makine").option("--notify", "sonucu (başarı/hata) bildirimle de göster").option("--args-env", "yolları VLAD_ARG_COUNT/VLAD_ARG_<n> ortam değişkenlerinden al (sağ tık başlatıcısı)");
const clip = program.command("clip").description("Ortak pano (Mac↔Windows)");
def(clip, "on", "Pano eşitlemeyi açar", async (o: Opts) => { await (await import("./clip/cli.js")).runClip("on", { json: !!o.json }); });
def(clip, "off", "Pano eşitlemeyi kapatır", async (o: Opts) => { await (await import("./clip/cli.js")).runClip("off", { json: !!o.json }); });
def(clip, "status", "Pano eşitleme durumu (enabled, agentRunning)", async (o: Opts) => { await (await import("./clip/cli.js")).runClip("status", { json: !!o.json }); });
def(clip, "get", "Yerel panoyu okur (resim varsa --out <png>)", async (o: Opts) => {
  await (await import("./clip/cli.js")).runClip("get", { json: !!o.json, out: o.out as string | undefined });
}).option("--out <png>", "resim panosunu bu PNG dosyasına yaz");
def(clip, "set [metin]", "Yerel panoya yazar (metin, --file <yol|->, ya da --image <png>)", async (text: string | undefined, o: Opts) => {
  await (await import("./clip/cli.js")).runClip("set", { json: !!o.json, text, file: o.file as string | undefined, image: o.image as string | undefined });
}).option("--file <yol>", "metni dosyadan (- = stdin) oku").option("--image <png>", "PNG dosyasını panoya yaz");
// --- /aktarim:S ---

def(program, "install", "SessionEnd hook'unu ve vlad-worker skill'ini ~/.claude'a kurar", async (o: Opts) => {
  const claudeDir = process.env.VLAD_CLAUDE_DIR || join(homedir(), ".claude");
  const actions = o.removeMenu ? [] : installGlobal({ home: getVladHome(), claudeDir, dryRun: !!o.dryRun }).actions;
  actions.push(...(await sendMenuActions(!!o.dryRun, !!o.removeMenu)));
  out(o, { actions }, actions.join("\n"));
}).option("--dry-run", "hiçbir şeye dokunmadan yapılacakları göster").option("--remove-menu", "yalnız sağ tık \"gönder\" menüsünü kaldırır (geri alma)");

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof CommanderError) {
    if (e.exitCode === 0) process.exit(0); // --help / --version
    if (e.code === "commander.help" || e.code === "commander.helpDisplayed") {
      process.stderr.write(pendingHelp); // bare group without subcommand
      process.exit(1);
    }
    fail(new Error(e.message.replace(/^error: /, "")));
  }
  fail(e);
}
