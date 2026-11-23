import type { Command } from "commander";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { soleTranscriptSession } from "../../tasks/liveness.js";
import { trustWorktree } from "../../tasks/trust.js";
import { startTrustGuard } from "../../tasks/trust-guard.js";
import { kbPaths, loadConfig, withKbLock } from "../../kb/index.js";
import { NoopLauncher, PosixLauncher, desktopQueueDir, enqueueDesktop, externalLaunch, secureDir, resolveLaunchMode, closeWorkerWindow } from "../../launcher/index.js";
import { brainTransport, markCleaned, syncKb, remoteCleanup, remoteClose, remoteNudge, remoteResume } from "../../machines/remote.js";
import { workerContext } from "../../agent/forward.js";
import { selfName } from "../../fleet/state.js";
import type { Launcher } from "../../launcher/index.js";
import { nudgeWorker } from "../../tasks/nudge.js";
import { cleanupMerged, humanBytes, type MergedResult } from "../../tasks/cleanup-merged.js";
import { cleanupTask, closeTaskWindow, logTask, remoteMachineOf, modelInfo, getTask, resumeLocalCheck, resumePrepare } from "../../tasks/index.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerTaskResume(task: Command, k: Kit): void {
  const { ctx, out, def } = k;
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
        try { closeTaskWindow(id, { closeWorker: closeWorkerWindow }); } catch (e) {
          // the noop guard throws by design; a real survivor must not get a second worker beside it
          if (mode !== "noop") throw new Error(`açık pencere kapatılamadı, ikinci çalışan açılmadı: ${(e as Error).message}`);
        }
        const res = await launcher.launch(req);
        if (!res.ok) throw new Error(`launcher başarısız (${res.method}): ${res.detail ?? "bilinmeyen hata"}`);
        if (mode !== "noop") startTrustGuard(id); // F-vlad-335: same first-minute watch as `task launch`
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
    const r = remote ? { id, killed: await remoteClose(brainTransport(cfg0, selfName()), remote, id) } : closeTaskWindow(id, { closeWorker: closeWorkerWindow });
    out(o, r, r.killed.length ? `${id} penceresi kapatıldı (pid: ${r.killed.join(", ")})` : `${id} için açık pencere yok`);
  });
  def(task, "nudge <id> <mesaj>", "Çalışanın penceresine (tmux; Windows konsolu; görev başka makinedeyse o makinenin Agent'ı) tek satır metin yazar, Enter'ı istem kutusu boşalana kadar tekrarlar (teslim doğrulanır)", async (id: string, msg: string, o: Opts) => {
    const t = getTask(id); // bilinmeyen görev açık hatayla düşer
    // F-vlad-370: görev başka makinede koşuyorsa istek o makinenin Agent'ına gider (pencere orada)
    const cfg0 = loadConfig();
    const remote = remoteMachineOf(t, cfg0, workerContext()?.self);
    const r = remote ? await remoteNudge(brainTransport(cfg0, selfName()), remote, id, msg) : await nudgeWorker(id, msg);
    out(o, { id, ...(remote ? { machine: remote } : {}), ...r }, r.delivered ? `${id}: mesaj teslim edildi${remote ? ` (${remote})` : ""} (Enter ×${r.enters})` : `${id}: mesaj istem kutusunda kaldı${remote ? ` (${remote})` : ""} (Enter ×${r.enters}); SendMessage ile dene`);
    if (!r.delivered) process.exitCode = 1;
  });
  def(task, "cleanup [id]", "done/cancelled görevin çalışan penceresini kapatır ve worktree'sini kaldırır; --merged: merge edilmiş tüm görevlerin worktree'lerini toplu kaldırır", async (id: string | undefined, o: Opts & { merged?: boolean; project?: string; dryRun?: boolean }) => {
    const cfg0 = loadConfig();
    if (o.merged) {
      // F-vlad-375: toplu temizlik; --dry-run hiçbir şeye dokunmaz (kb dahil)
      if (id) throw new Error("--merged ile görev ID'si verilmez");
      const run = () => cleanupMerged(cfg0, { dryRun: !!o.dryRun, ...(o.project ? { project: o.project } : {}), closeWorker: closeWorkerWindow });
      const r = run(); // kb kilidi yalnız silme anında, öğe başına (cleanupMerged içinde)
      const label = (i: MergedResult["items"][number]) =>
        i.action === "skip" ? `atlandı: ${i.id}: ${i.reason}`
          : i.removed ? `kaldırıldı: ${i.id} (~${humanBytes(i.bytes ?? 0)})`
          : i.error ? `HATA: ${i.id}: ${i.error}`
          : `kaldırılacak: ${i.id} (~${humanBytes(i.bytes ?? 0)})`;
      const nRemove = r.items.filter((i) => i.action === "remove").length;
      const summary = r.dryRun
        ? `${nRemove} worktree kaldırılacak (~${humanBytes(r.candidateBytes)}), ${r.items.length - nRemove} atlandı (dry-run; kaldırmak için --dry-run'sız çalıştır)`
        : `${r.removed} worktree kaldırıldı (~${humanBytes(r.freedBytes)} boşaldı), ${r.errors} hata, ${r.items.length - nRemove} atlandı`;
      out(o, r, [...r.items.map(label), summary].join("\n"));
      if (r.errors) process.exitCode = 1;
      return;
    }
    if (!id) throw new Error("görev ID'si gerekli (toplu temizlik için --merged)");
    // --- machines:C1 --- kb yazan cleanup kilitli; uzak makinedeki görevin worktree'si burada yok (C2)
    const remote = await withKbLock(() => {
      const t = getTask(id);
      const m = remoteMachineOf(t, cfg0);
      if (m) {
        if (t.data.state !== "done" && t.data.state !== "cancelled") throw new Error(`cleanup yalnızca done/cancelled görevde yapılır (${t.data.state}): ${id}`);
        return m;
      }
      cleanupTask(id, { cfg: cfg0, closeWorker: closeWorkerWindow });
      return null;
    });
    if (remote) {
      // ağ çağrısı kb kilidi dışında; kilit yalnız `worktree: null` yazısı için
      const cw = await remoteCleanup(brainTransport(cfg0, selfName()), remote, getTask(id));
      await withKbLock(() => markCleaned(id));
      if (cw?.length) { ctx.stderr.write(cw.map((w) => `uyarı: ${w}\n`).join("")); logTask(id, `cleanup uyarısı (${remote}): ${cw.join("; ")}`); } // F-vlad-263
    }
    // --- /machines:C1 ---
    out(o, { id }, `${id} worktree kaldırıldı`);
  }).option("--merged", "toplu: merge edilmiş done/cancelled görevlerin worktree'lerini kaldırır (dal silinmez)")
    .option("--project <slug>", "--merged: yalnız bu projenin görevleri")
    .option("--dry-run", "--merged: yalnız listele, hiçbir şeye dokunma");
}
