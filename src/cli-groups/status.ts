import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { def, defWrite, out, taskLine, type Opts } from "../cli-util.js";
import { listInboxWithWarnings, markDone } from "../inbox/inbox.js";
import { kbPaths, loadConfig } from "../kb/index.js";
import { statusSummary } from "../tasks/index.js";
import { docsRootNotice } from "../vault/search.js";

/** Docs root warning for the status output; a broken lookup never fails `vlad status`. */
function docsWarning(): string | null {
  try {
    const n = docsRootNotice();
    return n?.warn ? n.message : null;
  } catch {
    return null;
  }
}

/** Notes a docs root change once in <kb>/logs/docs-root.log (logs/ is not tracked). Full status only: --summary never writes. */
function logDocsRoot(): void {
  try {
    const n = docsRootNotice();
    if (!n) return;
    const file = join(kbPaths().logs, "docs-root.log");
    const last = existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").pop() ?? "" : "";
    if (last.replace(/^\S+ /, "") === n.message) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${n.message}\n`);
  } catch {
    /* a log that cannot be written is not worth a failed status */
  }
}

export function registerStatus(program: Command): void {
  defWrite(program, "status", "Aktif görevler; eski running görevleri stalled yapar", (o: Opts) => {
    const s = statusSummary(loadConfig(), new Date());
    if (o.summary) {
      // "rapor" covers inbox records and closing reports of done tasks that /digest has not processed
      const line =
        `İşlenmemiş ${s.inbox + s.undigested} rapor, ${s.active.length} aktif görev ` +
        `(${s.counts.awaiting_approval} onay bekliyor, ${s.counts.stalled} takıldı, ${s.counts.blocked} soru soruyor, ${s.failed.length} hatalı)` +
        (s.openSevereFindings ? `, ${s.openSevereFindings} açık kritik/yüksek bulgu` : "") +
        (docsWarning() ? `; uyarı: ${docsWarning()}` : "");
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
    logDocsRoot();
    const dw = docsWarning();
    if (dw) lines.push(`uyarı: ${dw}`);
    if (s.newlyStalled.length) lines.push(`takıldı: ${s.newlyStalled.join(", ")}`);
    if (s.failed.length) lines.push(`hatalı: ${s.failed.map((t) => t.data.id).join(", ")}`);
    out(o, { ...s, active: s.active.map((t) => t.data), failed: s.failed.map((t) => t.data), ...(dw ? { warnings: [dw] } : {}) }, lines.join("\n"));
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
