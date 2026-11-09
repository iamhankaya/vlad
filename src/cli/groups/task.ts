import type { Command } from "commander";
import { join } from "node:path";
import { probeIntegrationBranch } from "../../tasks/cloud.js";
import { verifyTrustAfterLaunch } from "../../tasks/trust.js";
import { readInput } from "../../kb/input.js";
import { loadConfig, withKbLock } from "../../kb/index.js";
import type { TaskKind, TaskState } from "../../kb/index.js";
import { NoopLauncher, PosixLauncher, TerminalLauncher, desktopQueueDir, queueLauncher, resolveLaunchMode, closeWorkerWindow } from "../../launcher/index.js";
import { brainTransport, makeRemote } from "../../machines/remote.js";
import { selfName } from "../../fleet/state.js";
import { AgentClient } from "../../agent/client.js";
import type { LaunchMode, LaunchResult, Launcher } from "../../launcher/index.js";
import { TRANSITIONS, answerTask, denyTask, askTask, cancelTask, createTask, launchTask, releaseTask, releaseWarning, repinPipeline, eventList, ingestEvents, logTask, pageWarnings, parseEvents, prepareCloudLaunch, reportReferencesPrior, reportTask, setDependencies, setState, unknownTaskRefs, unmetDependencies } from "../../tasks/index.js";
import { registerTaskResume } from "./task-resume.js";
import { registerTaskGate } from "./task-gate.js";
import { registerTaskList } from "./task-list.js";
import { closedFindingWarnings } from "../../findings/closed-report.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerTask(program: Command, k: Kit): void {
  const { ctx, out, def } = k;
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
      mode = resolveLaunchMode(cfg.launcher, process.platform, o.dryRun ? { ...ctx.env, VLAD_LAUNCHER: "" } : ctx.env);
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
    if ("warning" in q && q.warning) ctx.stderr.write(`uyarı: ${q.warning}\n`);
    const normal: Launcher = mode === "noop"
      ? new NoopLauncher()
      : mode === "tmux" || mode === "terminal"
        ? new PosixLauncher({ mode, dryRun: !!o.dryRun })
        : new TerminalLauncher({ mode: mode === "wt" || mode === "powershell" ? mode : "auto", dryRun: !!o.dryRun });
    const real: Launcher = o.external
      ? new TerminalLauncher({ mode: "auto", external: true })
      : q.dir ? queueLauncher(q.dir, "launch", normal) : normal;
    const warnings: string[] = [];
    // F-vlad-261: the trust record written before the window opens can be dropped by a live Claude; check after, repair or warn
    const launcher: Launcher = { launch: async (req) => {
      last = await real.launch(req);
      if (last.ok && !o.dryRun && !o.external && !q.dir && mode !== "noop" && process.platform !== "win32") {
        const w = verifyTrustAfterLaunch(req.cwd);
        if (w) { warnings.push(w); ctx.stderr.write(`uyarı: ${w}\n`); }
      }
      return last;
    } };
    // --- machines:C1 --- yerleştirme; C2: uzak taşıma (AgentClient) + launch öncesi kb-sync
    if (o.external && cfg.machines && o.machine && o.machine !== cfg.brain) throw new Error("--external uzak makinede desteklenmez");
    const t = await launchTask(id, { launcher, cfg, closeWorker: closeWorkerWindow, ...(o.external ? { external: true } : {}), ...(o.dryRun ? { dryRun: true } : {}), ...(o.machine ? { machine: o.machine as string } : {}), ...(cfg.machines ? { remote: makeRemote(cfg, selfName()) } : {}) });
    // --- /machines:C1 ---
    out(
      o,
      { id, state: t.data.state, branch: t.data.branch, worktree: t.data.worktree, method: last?.method, detail: last?.detail, ...(warnings.length ? { warnings } : {}), ...(o.external ? { script: last?.script, command: last?.command, cwd: last?.cwd } : {}), ...(last?.queued ? { queued: last.queued, script: last.script, cwd: last.cwd } : {}) },
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

  def(task, "repin <id> <makine>", "Pipeline çatısının makine pin'ini başka makineye taşır (eski makine erişilemezken)", async (id: string, machine: string, o: Opts) => {
    const r = await repinPipeline(id, machine, { cfg: loadConfig(), ...(o.force ? { force: true } : {}) });
    out(o, { id, from: r.from, to: machine, warnings: r.warnings }, [`${id} pin: ${r.from ?? "-"} → ${machine}`, ...r.warnings.map((w) => `uyarı: ${w}`)].join("\n"));
  }).option("--force", "eski makinede running faz varken de taşı (orada yetim kalabilir)");

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
  def(task, "deny <id>", "İzin reddini kaydeder: İlerleme'ye [İZİN] satırı + kb/logs/denials.jsonl (audit setup tekrarlayan kalıpları aday sayar)", (id: string, o: Opts) => {
    denyTask(id, { tool: o.tool as string, pattern: o.pattern as string, reason: o.reason as string | undefined });
    out(o, { id }, "kaydedildi");
  })
    .requiredOption("--tool <ad>", "reddedilen araç (Bash, PowerShell, ...)")
    .requiredOption("--pattern <komut>", "reddedilen komut/kalıp")
    .option("--reason <metin>", "ret nedeni (sınıflayıcı/izin kuralı mesajı)");
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
    warnings.push(...closedFindingWarnings(md));
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
  registerTaskResume(task, k);
  registerTaskGate(task, k);
  registerTaskList(task, k);
}
