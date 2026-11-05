import type { Command } from "commander";
import { join } from "node:path";
import type { RemoteStallPlan } from "../../tasks/liveness.js";
import { lintAgeNote } from "../../kb/lint-cache.js";
import { loadConfig } from "../../kb/index.js";
import { staleSummaryText } from "../../projects/status.js";
import { statusSummary } from "../../tasks/index.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerStatus(program: Command, k: Kit): void {
  const { ctx, out, def, statusLine, withModel } = k;
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
        (s.kbDirty ? `; UYARI: ${s.kbDirty.message}` : "") +
        (s.mode ? `; ${s.mode}` : "");
      if (o.hook) {
        // SessionStart hook JSON: systemMessage kullanıcıya görünür, additionalContext modelin bağlamına girer.
        ctx.stdout.write(JSON.stringify({
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
    if (s.kbDirty) lines.push(`UYARI: ${s.kbDirty.message}`);
    if (s.newlyStalled.length) lines.push(`takıldı: ${s.newlyStalled.join(", ")}`);
    if (s.failed.length) lines.push(`hatalı: ${s.failed.map((t) => t.data.id).join(", ")}`);
    out(o, { ...s, active: s.active.map((t) => withModel(t)), failed: s.failed.map((t) => t.data) }, lines.join("\n"));
  }).option("--summary", "tek satır özet")
    .option("--no-mark", "yan etkisiz okuma: stalled işaretleme ve mod penceresi temizliği yapılmaz (aynı JSON şekli)")
    .option("--hook", "--summary ile: SessionStart hook JSON'u (systemMessage + additionalContext)");
}
