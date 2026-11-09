import type { Command } from "commander";
import { join } from "node:path";
import { idleTasks } from "../../tasks/liveness.js";
import { loadConfig } from "../../kb/index.js";
import type { TaskState } from "../../kb/index.js";
import { listTasksWithWarnings, modelInfo, getTask, markDigested, readyWithLimit, saveTask } from "../../tasks/index.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

/** `task list --json` varsayılan alanları: vlad-desktop (src/models/task.ts) ve skill'lerin okuduğu kısa küme. */
const SHORT_FIELDS = ["id", "project", "title", "kind", "state", "autonomy", "branch", "worktree", "session_id", "created", "updated", "error", "role", "parent", "depends_on", "phase", "machine", "effective_model"];

export function registerTaskList(task: Command, k: Kit): void {
  const { ctx, out, def, taskLine, withModel, integrationInfo, TASK_FIELDS, DERIVED_FIELDS } = k;
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
    if (o.full && o.fields) throw new Error("--full ve --fields birlikte verilemez");
    // Varsayılan --json kısa: nadir/hesaplanan alanlar (role_model, integration_worktrees, model_reason…) yalnız --full ya da --fields ile (T20261110-14)
    const fields = o.fields ? String(o.fields).split(",").map((f) => f.trim()).filter(Boolean) : o.full ? undefined : SHORT_FIELDS;
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
    .option("--full", "--json çıktısı tüm alanlarla (role_model, integration_worktrees, model_reason, … dahil)")
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
