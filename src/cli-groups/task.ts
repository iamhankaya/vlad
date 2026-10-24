import type { Command } from "commander";
import { def, out, readInput, taskLine, type Opts } from "../cli-util.js";
import { loadConfig } from "../kb/index.js";
import type { TaskKind, TaskState } from "../kb/index.js";
import { TerminalLauncher, resolveLaunchMode } from "../launcher/index.js";
import type { LaunchMode, LaunchResult, Launcher } from "../launcher/index.js";
import {
  TRANSITIONS, answerTask, askTask, cleanupTask, createTask, launchTask, listTasksWithWarnings,
  eventList, getTask, ingestEvents, logTask, pageWarnings, parseEvents, markDigested, prepareCloudLaunch, readyWithLimit, reportTask, resumeInfo, saveTask, setState,
} from "../tasks/index.js";

export function registerTask(program: Command): void {
  const task = program.command("task").description("Görevler");
  def(task, "new", "queued görev oluşturur", (o: Opts) => {
    const body = o.bodyFile ? readInput(o.bodyFile as string) : "";
    const dependsOn = o.dependsOn ? String(o.dependsOn).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const t = createTask({
      project: o.project as string, title: o.title as string, kind: o.kind as TaskKind, body, role: o.role as string | undefined,
      parent: o.parent as string | undefined, dependsOn, phase: o.phase as string | undefined,
    });
    out(o, { id: t.data.id }, t.data.id);
  })
    .option("--role <slug>", "roles/<slug>.md uzman rolü (advisory → research, executor → dev)")
    .option("--parent <id>", "çatı (pipeline) görevi")
    .option("--depends-on <ids>", "virgülle ayrılmış, aynı pipeline'daki bağımlılıklar")
    .option("--phase <ad>", "faz adı (spec, tasarım, plan, sözleşme, kabul, karakterizasyon, uygulama, doğrulama, denetim, prova, danışma)")
    .requiredOption("--project <slug>", "proje slug'ı")
    .requiredOption("--title <başlık>", "görev başlığı")
    .option("--kind <kind>", "dev | research | pipeline", "dev")
    .option("--body-file <md>", "görev gövdesi (- = stdin)");

  def(task, "launch <id>", "Worktree + branch açar, running yapar, Launcher'ı çağırır", async (id: string, o: Opts) => {
    const cfg = loadConfig();
    let mode: LaunchMode;
    try {
      mode = resolveLaunchMode(cfg.launcher);
    } catch (e) {
      if (!o.dryRun) throw e; // a dry run only prints the terminal command, so it works anywhere
      mode = "auto-terminal";
    }
    if (mode === "cloud") {
      const r = prepareCloudLaunch(id);
      out(o, r, `${id} bulut çalışanı için hazır (running)\nrepo: ${r.repo}\nbranch: ${r.outcome_branch}\n` +
        `base: ${r.base_branch}\n${r.next.map((n) => `- ${n}`).join("\n")}` +
        r.warnings.map((w) => `\nuyarı: ${w}`).join(""));
      return;
    }
    let last: LaunchResult | undefined;
    const real = new TerminalLauncher({ mode: mode === "wt" || mode === "powershell" ? mode : "auto", dryRun: !!o.dryRun });
    const launcher: Launcher = { launch: async (req) => (last = await real.launch(req)) };
    const t = await launchTask(id, { launcher, cfg });
    out(
      o,
      { id, state: t.data.state, branch: t.data.branch, worktree: t.data.worktree, method: last?.method, detail: last?.detail },
      `${id} başlatıldı (${last?.method}) -> ${t.data.worktree}${o.dryRun ? "\n(dry-run) " + (last?.detail ?? "") : ""}`,
    );
  }).option("--dry-run", "terminal açmadan komutu göster");

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
    const t = reportTask(id, readInput(o.file as string));
    out(o, { id, state: t.data.state }, `${id} -> ${t.data.state}`);
  }).requiredOption("--file <md>", "rapor dosyası (- = stdin)");
  def(task, "set <id> <state>", "Durum makinesine uygun geçiş", (id: string, state: string, o: Opts) => {
    if (!(state in TRANSITIONS)) throw new Error(`bilinmeyen durum: ${state}; geçerliler: ${Object.keys(TRANSITIONS).join(", ")}`);
    const t = setState(id, state as TaskState);
    out(o, { id, state: t.data.state }, `${id} -> ${t.data.state}`);
  });
  def(task, "resume <id>", "running/stalled görev için devam bilgisi (yerel: worktree kontrolü + prompt; bulut: send_message argümanları)", (id: string, o: Opts) => {
    const r = resumeInfo(id);
    out(o, r, r.mode === "local"
      ? `${r.prompt}${r.dirty.length ? `\nkaydedilmemiş: ${r.dirty.join(", ")}` : ""}`
      : `send_message session_id=${r.session_id}\n${r.message}`);
  });
  def(task, "cleanup <id>", "done/cancelled görevin çalışan penceresini kapatır ve worktree'sini kaldırır", (id: string, o: Opts) => {
    cleanupTask(id);
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
    out(
      o,
      { tasks: tasks.map((t) => t.data), warnings },
      [...tasks.map(taskLine), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
    );
  })
    .option("--state <states>", "virgülle ayrılmış durumlar")
    .option("--project <slug>", "proje slug'ı")
    .option("--undigested", "yalnızca kapanış raporu /digest'te işlenmemiş done görevler")
    .option("--parent <id>", "yalnızca bu pipeline'ın fazları");
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
}
