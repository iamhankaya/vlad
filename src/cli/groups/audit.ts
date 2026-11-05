import type { Command } from "commander";
import { join } from "node:path";
import { auditSetup } from "../../audit/setup.js";
import { auditSkills } from "../../audit/skills.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerAudit(program: Command, k: Kit): void {
  const { out, def } = k;
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

  def(audit, "setup", "Kurulum denetimi verisi (salt okuma): biten görevler, ölçümler, sürtünme işaretleri, skill envanteri, yaşlı bulgular", (o: Opts) => {
    const r = auditSetup({ since: o.since as string | undefined });
    const sev = Object.entries(r.open_points.by_severity).map(([k, v]) => `${k}:${v}`).join(" ") || "-";
    const sg = r.signals;
    out(o, r, [
      `aralık: ${r.since} → ${r.tasks.total} biten görev`,
      `ölçüm: ${r.measures.tasks_with_measure} görevde; ${Object.entries(r.measures.sums).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`,
      ...(r.measures.by_ponytail.on.tasks + r.measures.by_ponytail.off.tasks ? [`ponytail A/B: ` + (['on', 'off'] as const).map((k) => `${k} ${r.measures.by_ponytail[k].tasks} görev (${r.measures.by_ponytail[k].tasks_with_measure} ölçümlü; ${Object.entries(r.measures.by_ponytail[k].sums).map(([n, v]) => `${n}=${v}`).join(' ') || '-'})`).join(' | ')] : []),
      `açık nokta: ${r.open_points.total} (${sev})`,
      `işaretler: test itirazı ${sg.test_itirazi.count}, değişiklik turu ${sg.degisiklik_istegi.count}, [KARAR] ${sg.karar.count}, izin reddi ${sg.izin_reddi.count}, Codex turu ara ${sg.codex_turlari.ara}/son ${sg.codex_turlari.son} (${sg.codex_turlari.tasks} çatıda ölçüm)`,
      `skill: ${r.skills.inventory.length} envanterde, ${r.skills.unused.length} hiç yüklenmemiş (${r.skills.transcripts} oturum kaydı); rol skill oranı ${r.skills.coverage.rate === null ? "-" : `%${Math.round(r.skills.coverage.rate * 100)} (${r.skills.coverage.loaded}/${r.skills.coverage.expected}, kuraldan önceki ${r.skills.coverage.skipped_before_rule} atlandı)`}`,
      `iptal: ${r.cancelled.total} görev, ${r.cancelled.with_reason} gerekçeli`,
      `bulgu: ${r.findings.unresolved.length} açık/ertelenmiş, ${r.findings.stale} tanesi 30 günden eski`,
    ].join("\n"));
  }).option("--since <tarih>", "bu tarihten sonra biten görevler (YYYY-MM-DD; varsayılan: 14 gün önce)");
}
