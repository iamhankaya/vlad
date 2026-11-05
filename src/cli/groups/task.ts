import type { Command } from "commander";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idleTasks, soleTranscriptSession } from "../../tasks/liveness.js";
import { trustWorktree } from "../../tasks/trust.js";
import { probeIntegrationBranch } from "../../tasks/cloud.js";
import { readInput } from "../../kb/input.js";
import { kbPaths, loadConfig, withKbLock } from "../../kb/index.js";
import type { TaskKind, TaskState } from "../../kb/index.js";
import { NoopLauncher, PosixLauncher, TerminalLauncher, desktopQueueDir, enqueueDesktop, externalLaunch, secureDir, queueLauncher, resolveLaunchMode } from "../../launcher/index.js";
import { brainTransport, gateMachineOf, makeRemote, markCleaned, syncKb, remoteCleanup, remoteClose, recordGreenGate, defaultGateTarget, remoteGateRun, remoteMerge, remoteMergePreview, remoteResume } from "../../machines/remote.js";
import { workerContext } from "../../agent/forward.js";
import { selfName } from "../../agent/state.js";
import { AgentClient } from "../../agent/client.js";
import type { LaunchMode, LaunchResult, Launcher } from "../../launcher/index.js";
import { TRANSITIONS, answerTask, askTask, cancelTask, cleanupTask, closeTaskWindow, createTask, launchTask, releaseTask, releaseWarning, remoteMachineOf, listTasksWithWarnings, modelInfo, eventList, getTask, ingestEvents, logTask, pageWarnings, parseEvents, markDigested, prepareCloudLaunch, readyWithLimit, reportReferencesPrior, reportTask, resumeLocalCheck, resumePrepare, saveTask, setDependencies, setState, unknownTaskRefs, unmetDependencies } from "../../tasks/index.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerTask(program: Command, k: Kit): void {
  const { ctx, out, def, taskLine, withModel, integrationInfo, TASK_FIELDS, DERIVED_FIELDS } = k;
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
    if (trustWarn) ctx.stderr.write(`uyarı: ${trustWarn}\n`);
    const rq: { dir: string | null; warning?: string } = o.external || r.mode !== "local" ? { dir: null as string | null } : desktopQueueDir();
    if ("warning" in rq && rq.warning) ctx.stderr.write(`uyarı: ${rq.warning}\n`);
    // POSIX: a plain resume opens the worker like `task launch` does (F-vlad-202: it used to only print the prompt)
    const openWindow = !o.external && !rq.dir && r.mode === "local" && process.platform !== "win32" && resolveLaunchMode(cfg0.launcher) !== "cloud";
    if (o.external || rq.dir || openWindow) {
      if (r.mode !== "local") throw new Error("--external yerel çalışan içindir; bulut görevi için --external kullanılamaz");
      const t = getTask(id);
      const model = modelInfo(t.data).effective_model;
      const autoCompact = loadConfig().workerAutoCompact;
      const sid = t.data.session_id?.trim() || soleTranscriptSession(r.worktree);
      if (rq.dir) {
        try { secureDir(join(tmpdir(), "vlad")); } catch (e) {
          ctx.stderr.write(`uyarı: betik klasörü korunamadı (${(e as Error).message}); kuyruk yazılamadı, devam bilgisi yazdırılıyor
`);
          rq.dir = null;
        }
      }
      const req = {
        taskId: id, cwd: r.worktree, prompt: r.prompt, env: { VLAD_TASK_ID: id, VLAD_HOME: kbPaths().home },
        title: `VLAD ${id} — ${t.data.title}`, ...(model ? { model } : {}),
        ...(autoCompact ? { autoCompact } : {}),
        // keep the worker's context. No recorded session: only the worktree's single transcript is safe to resume; `--continue` could pick any session (F-vlad-097), so otherwise start fresh (the prompt carries the log tail)
        ...(sid ? { resume: { sessionId: sid } } : {}),
      };
      if (openWindow) {
        const mode = resolveLaunchMode(cfg0.launcher);
        const launcher: Launcher = mode === "noop" ? new NoopLauncher() : new PosixLauncher({ mode: mode === "terminal" ? "terminal" : "tmux" });
        try { closeTaskWindow(id); } catch (e) {
          // the noop guard throws by design; a real survivor must not get a second worker beside it
          if (mode !== "noop") throw new Error(`açık pencere kapatılamadı, ikinci çalışan açılmadı: ${(e as Error).message}`);
        }
        const res = await launcher.launch(req);
        if (!res.ok) throw new Error(`launcher başarısız (${res.method}): ${res.detail ?? "bilinmeyen hata"}`);
        out(o, { ...r, method: res.method, detail: res.detail }, `${id} sürdürüldü (${res.method}) -> ${r.worktree}${r.dirty.length ? `\nkaydedilmemiş: ${r.dirty.join(", ")}` : ""}`);
        return;
      }
      const ext = externalLaunch(req);
      if (!ext.ok) throw new Error(`betik yazılamadı: ${ext.detail}`);
      if (o.external || !rq.dir) {
        out(o, { ...r, script: ext.script, command: ext.command, cwd: ext.cwd }, `${ext.script}\n${ext.command}`);
        return;
      }
      try {
        const queued = enqueueDesktop(rq.dir, { kind: "resume", taskId: id, script: ext.script!, cwd: ext.cwd!, ...(ext.scriptSha256 ? { scriptSha256: ext.scriptSha256 } : {}) });
        out(o, { ...r, method: "desktop-queue", queued, script: ext.script, cwd: ext.cwd }, `${id} vlad-desktop kuyruğuna yazıldı: ${queued}`);
        return;
      } catch (e) {
        ctx.stderr.write(`uyarı: kuyruk yazılamadı (${(e as Error).message}); devam bilgisi yazdırılıyor\n`); // falls through to the plain resume output
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
    for (const w of r.warnings ?? []) ctx.stderr.write(`uyarı: ${w}\n`);
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
}
