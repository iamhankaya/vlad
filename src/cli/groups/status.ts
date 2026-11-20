import type { Command } from "commander";
import { join } from "node:path";
import type { RemoteStallPlan } from "../../tasks/liveness.js";
import { lintAgeNote, refreshLintCacheIfStale } from "../../audit/lint-cache.js";
import { workerState } from "../../agent/forward.js";
import { loadConfig } from "../../kb/index.js";
import { staleSummaryText, undigestedNote } from "../../projects/status.js";
import { statusSummary } from "../../tasks/index.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";
import { countNotices, defaultNotifyDir, listNotices } from "../../monitor/notify.js";

/** Monitor bildirim kuyruğu özeti; okunamazsa sessizce 0 (açılış özetini asla düşürme). */
function monitorNotices(): { count: number; items: { task: string; kind: string }[] } {
  try {
    const dir = defaultNotifyDir();
    return { count: countNotices(dir), items: listNotices(dir, { limit: 3 }).map((x) => ({ task: x.task, kind: x.kind })) };
  } catch { return { count: 0, items: [] }; }
}

export function registerStatus(program: Command, k: Kit): void {
  const { ctx, out, def, statusLine, withModel } = k;
  def(program, "status", "Aktif görevler; eski running görevleri stalled yapar", (o: Opts) => {
    // SessionStart hook: refresh a stale lint cache first (short timeout); a refresh that did not finish shows the old numbers as "eski"
    const lintStale = o.hook && o.summary && o.mark !== false ? refreshLintCacheIfStale({ canRun: () => ["brain", "off"].includes(workerState().kind) }).stale : false;
    const s = statusSummary(loadConfig(), new Date(), undefined, undefined, { mark: o.mark !== false, remotePlans: o.remotePlans as RemoteStallPlan[] | undefined });
    if (o.summary) {
      const mn = monitorNotices();
      // "rapor" covers inbox records and closing reports of done tasks that /digest has not processed
      const line =
        `İşlenmemiş ${s.inbox + s.undigested} rapor, ${s.active.length} aktif görev ` +
        `(${s.counts.awaiting_approval} onay bekliyor, ${s.counts.stalled} takıldı, ${s.counts.blocked} soru soruyor, ${s.failed.length} hatalı)` +
        (s.undigested ? `, ${undigestedNote(s.undigested, s.oldestUndigested)}` : "") +
        (s.staleSummaries.length ? `, ${s.staleSummaries.length} bayat/eksik proje özeti: ${staleSummaryText(s.staleSummaries)}` : "") +
        (s.pendingDigest ? `, ${s.pendingDigest} onay bekleyen digest maddesi` : "") +
        (s.openSevereFindings ? `, ${s.openSevereFindings} açık kritik/yüksek bulgu` : "") +
        (s.kbLint.count ? `, ${s.kbLint.count} kb çelişkisi${lintStale ? " (lint önbelleği eski)" : lintAgeNote(s.kbLint)}` : lintStale ? ", kb lint önbelleği eski" : "") +
        (mn.count ? `, ${mn.count} monitor bildirimi (${mn.items.map((x) => x.task).join(", ")}${mn.count > mn.items.length ? ", …" : ""})` : "") +
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
      out(o, { ...s, ...(mn.count ? { monitorNotices: mn } : {}), active: s.active.map((t) => t.data), failed: s.failed.map((t) => t.data), summary: line }, line);
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
