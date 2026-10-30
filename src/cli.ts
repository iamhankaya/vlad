#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Command, CommanderError } from "commander";
import { addFinding, listFindingsWithWarnings, parseFilter, setFindingState, SEVERITIES, STATES } from "./findings/store.js";
import { auditSkills } from "./audit/skills.js";
import { expireMode, modeLine, modeStatus, setNight, setOff, setWatch } from "./mode/store.js";
import { idleTasks } from "./tasks/liveness.js";
import { listInboxWithWarnings, markDone } from "./inbox/inbox.js";
import { installGlobal } from "./install.js";
import { checkKb, kbCheckExitCode } from "./kb/check.js";
import { commitKb } from "./kb/commit.js";
import { readInput } from "./kb/input.js";
import { addDecision, appendJournal, getJournal, getVladHome, kbPaths, getKbRecord, listDecisions, loadConfig, maintainKb, migrateDecisions, searchKb, setDecisionStatus, DECISION_STATUSES, ValidationError, writeFileAtomic } from "./kb/index.js";
import type { TaskKind, TaskState } from "./kb/index.js";
import { NoopLauncher, TerminalLauncher, externalLaunch, resolveLaunchMode } from "./launcher/index.js";
import { swallowEpipe } from "./stdout.js";
import type { LaunchMode, LaunchResult, Launcher } from "./launcher/index.js";
import { projectStatus, setProjectSummary } from "./projects/status.js";
import { addProjectNote, listProjectsWithWarnings, setProjectField, writeProject } from "./projects/store.js";
import { listRolesWithWarnings } from "./roles/store.js";
import { scanRootsWithWarnings } from "./scan/scan.js";
import {
  TRANSITIONS, TransitionError, answerTask, askTask, cleanupTask, closeTaskWindow, createTask, integrationWorktrees, launchTask, listTasksWithWarnings, modelInfo,
  eventList, getTask, ingestEvents, logTask, pageWarnings, parseEvents, markDigested, prepareCloudLaunch, readyWithLimit, reportReferencesPrior, reportTask, resumeInfo, saveTask, setDependencies, setState, statusSummary, unknownTaskRefs, unmetDependencies,
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
  if (wantsJson()) process.stderr.write(JSON.stringify({ error, details }) + "\n");
  else {
    error = `hata: ${error}`;
    process.stderr.write([error, ...details.map((d) => `  ${d}`)].join("\n") + "\n");
  }
  process.exit(1);
}

function out(o: Opts, data: unknown, text: string): void {
  process.stdout.write((o.json ? JSON.stringify(data) : text) + "\n");
}

const taskLine = (t: Task) => `${t.data.id}  ${t.data.state.padEnd(17)} ${t.data.project}  ${t.data.title}`;
/** Pipeline tasks carry their per-project integration worktrees (F-vlad-063); a missing project card must not break listing. */
const integrationInfo = (t: Task, all?: Task[]) => {
  if (t.data.kind !== "pipeline") return {};
  try { return { integration_worktrees: integrationWorktrees(t.data.id, loadConfig(), all) }; } catch { return {}; }
};
/** Task data plus the model it runs on (task `model` ?? role `model`), for --json consumers. */
const withModel = (t: Task, all?: Task[]) => ({ ...t.data, ...modelInfo(t.data), ...integrationInfo(t, all) });
/** Fields `task list --fields` can pick: the task frontmatter plus derived ones (computed only when asked for). */
const TASK_FIELDS = ["id", "project", "title", "kind", "state", "autonomy", "branch", "worktree", "session_id", "created", "updated", "error", "digested", "role", "parent", "depends_on", "phase", "report_file", "model", "model_reason"];
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

/** Registers a command with --json and a uniform error path. */
function def(parent: Command, spec: string, desc: string, fn: (...a: any[]) => void | Promise<void>): Command {
  const c = parent.command(spec).description(desc).option("--json", "makine okunur çıktı");
  c.action(async (...args: any[]) => {
    try {
      await fn(...args);
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
def(project, "set <slug> <field> <value>", "Tek kart alanını yazar (exposure|repo|default_branch|local_only|local_only_reason|gate); boş değer alanı siler", (slug: string, field: string, value: string, o: Opts) => {
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
    ...s.decisions.recent.map((d) => `  ${d.id}  ${d.date}  ${d.title}`),
  ];
  out(o, s, lines.join("\n"));
});
def(project, "summary <slug>", "Kartın `## Durum özeti` bölümünü yazar (/digest); ilk satıra 'Güncel' damgası eklenir", (slug: string, o: Opts) => {
  const stamp = setProjectSummary(slug, readInput(o.file as string));
  out(o, { slug, as_of: stamp }, `özet yazıldı: ${slug} (${stamp})`);
}).requiredOption("--file <md>", "özet metni (- = stdin); en çok ~1000 token");
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
    const r = prepareCloudLaunch(id);
    out(o, r, `${id} bulut çalışanı için hazır (running)\nrepo: ${r.repo}\nbranch: ${r.outcome_branch}\n` +
      `base: ${r.base_branch}\n${r.next.map((n) => `- ${n}`).join("\n")}` +
      r.warnings.map((w) => `\nuyarı: ${w}`).join(""));
    return;
  }
  let last: LaunchResult | undefined;
  // --external (vlad-desktop): only writes the script; the caller opens it, so no terminal and no noop guard
  const real = o.external
    ? new TerminalLauncher({ mode: "auto", external: true })
    : mode === "noop"
      ? new NoopLauncher()
      : new TerminalLauncher({ mode: mode === "wt" || mode === "powershell" ? mode : "auto", dryRun: !!o.dryRun });
  const launcher: Launcher = { launch: async (req) => (last = await real.launch(req)) };
  const t = await launchTask(id, { launcher, cfg });
  out(
    o,
    { id, state: t.data.state, branch: t.data.branch, worktree: t.data.worktree, method: last?.method, detail: last?.detail, ...(o.external ? { script: last?.script, command: last?.command, cwd: last?.cwd } : {}) },
    `${id} başlatıldı (${last?.method}) -> ${t.data.worktree}${o.dryRun ? "\n(dry-run) " + (last?.detail ?? "") : ""}${o.external ? `\ncommand: ${last?.command}` : ""}`,
  );
}).option("--dry-run", "terminal açmadan komutu göster")
  .option("--external", "terminal açma; betiği yaz, script/command/cwd döndür (gömülü kullanım)");

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
  const t = setState(id, state as TaskState);
  out(o, { id, state: t.data.state }, `${id} -> ${t.data.state}`);
});
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
def(task, "resume <id>", "running/stalled görev için devam bilgisi (yerel: worktree kontrolü + prompt; bulut: send_message argümanları)", (id: string, o: Opts) => {
  const r = resumeInfo(id);
  if (o.external) {
    if (r.mode !== "local") throw new Error("--external yerel çalışan içindir; bulut görevi için --external kullanılamaz");
    const t = getTask(id);
    const model = modelInfo(t.data).effective_model;
    const ext = externalLaunch({
      taskId: id, cwd: r.worktree, prompt: r.prompt, env: { VLAD_TASK_ID: id, VLAD_HOME: kbPaths().home },
      title: `VLAD ${id} — ${t.data.title}`, ...(model ? { model } : {}),
    });
    if (!ext.ok) throw new Error(`betik yazılamadı: ${ext.detail}`);
    out(o, { ...r, script: ext.script, command: ext.command, cwd: ext.cwd }, `${ext.script}\n${ext.command}`);
    return;
  }
  out(o, r, r.mode === "local"
    ? `${r.prompt}${r.dirty.length ? `\nkaydedilmemiş: ${r.dirty.join(", ")}` : ""}`
    : `send_message session_id=${r.session_id}\n${r.message}`);
}).option("--external", "yerel çalışan için betik yaz (terminal açma); script/command/cwd döner");
def(task, "close-window <id>", "Görevin çalışan penceresini/süreç ağacını kapatır; durum ve worktree değişmez", (id: string, o: Opts) => {
  const r = closeTaskWindow(id);
  out(o, r, r.killed.length ? `${id} penceresi kapatıldı (pid: ${r.killed.join(", ")})` : `${id} için açık pencere yok`);
});
def(task, "cleanup <id>", "done/cancelled görevin çalışan penceresini kapatır ve worktree'sini kaldırır", (id: string, o: Opts) => {
  cleanupTask(id, { cfg: loadConfig() });
  out(o, { id }, `${id} worktree kaldırıldı`);
});
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
def(task, "ready", "Başlatılmaya hazır görevler (queued, bağımlılıkları done)", (o: Opts) => {
  const r = readyWithLimit({ parent: o.parent as string | undefined }, loadConfig().maxParallel);
  const lines = [
    ...r.tasks.map(taskLine),
    ...r.held_by_limit.map((t) => `${taskLine(t)}  (maxParallel dolu: ${r.running}/${r.maxParallel}, bekliyor)`),
  ];
  out(
    o,
    { tasks: r.tasks.map((t) => t.data), held_by_limit: r.held_by_limit.map((t) => t.data), running: r.running, maxParallel: r.maxParallel },
    lines.join("\n"),
  );
}).option("--parent <id>", "yalnızca bu pipeline'ın fazları");

def(program, "status", "Aktif görevler; eski running görevleri stalled yapar", (o: Opts) => {
  const s = statusSummary(loadConfig(), new Date(), undefined, undefined, { mark: o.mark !== false });
  if (o.summary) {
    // "rapor" covers inbox records and closing reports of done tasks that /digest has not processed
    const line =
      `İşlenmemiş ${s.inbox + s.undigested} rapor, ${s.active.length} aktif görev ` +
      `(${s.counts.awaiting_approval} onay bekliyor, ${s.counts.stalled} takıldı, ${s.counts.blocked} soru soruyor, ${s.failed.length} hatalı)` +
      (s.openSevereFindings ? `, ${s.openSevereFindings} açık kritik/yüksek bulgu` : "") +
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

const decision = program.command("decision").description("Karar günlüğü");
def(decision, "add", "kb/decisions/<proje>.md'ye karar ekler; D-<proje>-NNN ID'si döner", (o: Opts) => {
  const id = addDecision({
    project: o.project as string,
    title: o.title as string,
    body: readInput(o.bodyFile as string),
    source: o.source as string | undefined,
    supersedes: o.supersedes as string | undefined,
  });
  out(o, { ok: true, id }, `karar eklendi: ${id}`);
})
  .requiredOption("--project <slug>", "proje")
  .requiredOption("--title <başlık>", "başlık")
  .requiredOption("--body-file <md>", "gövde (- = stdin)")
  .option("--source <kaynak>", "session/görev kaynağı")
  .option("--supersedes <id>", "bu kararın yerine geçtiği karar (o yerine-geçti olur)");
def(decision, "list", "Kararları kısa listeler (varsayılan yalnız geçerli)", (o: Opts) => {
  const decisions = listDecisions({ project: o.project as string | undefined, all: !!o.all }).map(({ path: _p, ...d }) => d); // paths are for `kb search`; they only bloat a list
  out(o, { decisions }, decisions.map((d) => `${d.id}  ${d.date}  ${d.status}  ${d.title}${d.superseded_by ? `  -> ${d.superseded_by}` : ""}`).join("\n"));
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

def(program, "install", "SessionEnd hook'unu ve vlad-worker skill'ini ~/.claude'a kurar", (o: Opts) => {
  const claudeDir = process.env.VLAD_CLAUDE_DIR || join(homedir(), ".claude");
  const { actions } = installGlobal({ home: getVladHome(), claudeDir, dryRun: !!o.dryRun });
  out(o, { actions }, actions.join("\n"));
}).option("--dry-run", "hiçbir şeye dokunmadan yapılacakları göster");

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
