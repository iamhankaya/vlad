import type { Command } from "commander";
import { def, defWrite, out, taskLine, type Opts } from "../cli-util.js";
import { listInboxWithWarnings, markDone } from "../inbox/inbox.js";
import { loadConfig } from "../kb/index.js";
import { statusSummary } from "../tasks/index.js";

export function registerStatus(program: Command): void {
  defWrite(program, "status", "Aktif görevler; eski running görevleri stalled yapar", (o: Opts) => {
    const s = statusSummary(loadConfig(), new Date());
    if (o.summary) {
      // "rapor" covers inbox records and closing reports of done tasks that /digest has not processed
      const line =
        `İşlenmemiş ${s.inbox + s.undigested} rapor, ${s.active.length} aktif görev ` +
        `(${s.counts.awaiting_approval} onay bekliyor, ${s.counts.stalled} takıldı, ${s.counts.blocked} soru soruyor, ${s.failed.length} hatalı)` +
        (s.openSevereFindings ? `, ${s.openSevereFindings} açık kritik/yüksek bulgu` : "");
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
    const lines = [...s.active.map(taskLine), `inbox: ${s.inbox}`];
    if (s.newlyStalled.length) lines.push(`takıldı: ${s.newlyStalled.join(", ")}`);
    if (s.failed.length) lines.push(`hatalı: ${s.failed.map((t) => t.data.id).join(", ")}`);
    out(o, { ...s, active: s.active.map((t) => t.data), failed: s.failed.map((t) => t.data) }, lines.join("\n"));
  }, { guard: (o) => (o.summary ? "off" : "full") }).option("--summary", "tek satır özet")
    .option("--hook", "--summary ile: SessionStart hook JSON'u (systemMessage + additionalContext)");

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
  defWrite(inbox, "done <dosyalar...>", "Raporları processed/'a taşır", (files: string[], o: Opts) => {
    markDone(files);
    out(o, { moved: files }, `${files.length} rapor taşındı`);
  });
}
