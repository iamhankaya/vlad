import type { Command } from "commander";
import { join } from "node:path";
import { addFinding, listFindingsWithWarnings, parseFilter, setFindingStates, SEVERITIES, STATES } from "../../findings/store.js";
import { similarOpenFindings } from "../../findings/similar.js";
import { readInput } from "../../kb/input.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

const parseDays = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`geçersiz --older-than: "${v}" (gün sayısı, ≥ 0)`);
  return n;
};

export function registerFinding(program: Command, k: Kit): void {
  const { out, def } = k;
  const finding = program.command("finding").description("Bulgu kaydı (ertelenen/açık noktalar)");
  const findingLine = (f: { data: { id: string; severity: string; state: string; project: string; title: string; fixed_by?: string | null } }) =>
    `${f.data.id}  ${f.data.severity.padEnd(7)} ${f.data.state.padEnd(8)} ${f.data.title}${f.data.fixed_by ? `  (düzeltti: ${f.data.fixed_by})` : ""}`;
  def(finding, "add", "Bulgu kaydı oluşturur (varsayılan open)", (o: Opts) => {
    // checked before the write so the new finding cannot match itself; a warning only, never a refusal
    const similar = similarOpenFindings(o.project as string, o.title as string).map((x) => ({ similar: x.data.id }));
    const f = addFinding({
      project: o.project as string, severity: o.severity as string, source: o.source as string, title: o.title as string,
      detail: o.detailFile ? readInput(o.detailFile as string) : undefined, state: o.state as string | undefined,
    });
    for (const w of similar) process.stderr.write(`uyarı: benzer açık bulgu: ${w.similar} (birleştir ya da digest-pending'e ekle)\n`);
    out(o, similar.length ? { id: f.data.id, warnings: similar } : { id: f.data.id }, f.data.id);
  })
    .requiredOption("--project <slug>", "proje slug'ı")
    .requiredOption("--severity <önem>", SEVERITIES.join(" | "))
    .requiredOption("--source <görev>", "bulguyu raporlayan görev ID'si")
    .requiredOption("--title <başlık>", "bulgu başlığı")
    .option("--detail-file <md>", "ayrıntı (- = stdin)")
    .option("--state <durum>", "open | deferred", "open");
  def(finding, "list", "Bulguları listeler", (o: Opts) => {
    const { findings, warnings } = listFindingsWithWarnings({
      project: o.project as string | undefined,
      state: o.state ? parseFilter(String(o.state), STATES, "durum") : undefined,
      severity: o.severity ? parseFilter(String(o.severity), SEVERITIES, "önem") : undefined,
      olderThanDays: o.olderThan !== undefined ? parseDays(o.olderThan) : undefined,
      source: o.source as string | undefined,
    });
    out(
      o,
      { findings: findings.map((f) => ({ ...f.data, detail: f.body.replace(/^## Ayrıntı\n?/, "").trim() })), warnings },
      [...findings.map(findingLine), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
    );
  })
    .option("--project <slug>", "proje slug'ı")
    .option("--state <durumlar>", `virgülle ayrılmış: ${STATES.join(", ")}`)
    .option("--severity <önemler>", `virgülle ayrılmış: ${SEVERITIES.join(", ")}`)
    .option("--older-than <gün>", "yalnız bu kadar günden eski (created) bulgular")
    .option("--source <görev>", "yalnız bu görevin raporladığı bulgular");
  def(finding, "set <args...>", "Bulgu(lar)ın durumunu değiştirir: set <id...> <durum> (hepsi ya da hiçbiri)", (args: string[], o: Opts) => {
    if (args.length < 2) throw new Error("kullanım: finding set <id...> <durum>");
    const state = args[args.length - 1]!;
    const ids = args.slice(0, -1);
    const fs = setFindingStates(ids, state, { by: o.by as string | undefined, reason: o.reason as string | undefined });
    const rows = fs.map((f) => ({ id: f.data.id, state: f.data.state, fixed_by: f.data.fixed_by ?? null }));
    // one id keeps the original single-object shape (desktop console and scripts read it)
    out(o, rows.length === 1 ? rows[0]! : { updated: rows }, rows.map((r) => `${r.id} -> ${r.state}`).join("\n"));
  })
    .option("--by <görev>", "düzelten görev (yalnızca fixed)")
    .option("--reason <metin>", "gerekçe (wontfix'te zorunlu); bulgu dosyasına ## Kapanış olarak yazılır");
}
