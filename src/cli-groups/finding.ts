import type { Command } from "commander";
import { def, defWrite, out, readInput, type Opts } from "../cli-util.js";
import { addFinding, listFindingsWithWarnings, parseFilter, setFindingState, SEVERITIES, STATES } from "../findings/store.js";

export function registerFinding(program: Command): void {
  const finding = program.command("finding").description("Bulgu kaydı (ertelenen/açık noktalar)");
  const findingLine = (f: { data: { id: string; severity: string; state: string; project: string; title: string; fixed_by?: string | null } }) =>
    `${f.data.id}  ${f.data.severity.padEnd(7)} ${f.data.state.padEnd(8)} ${f.data.title}${f.data.fixed_by ? `  (düzeltti: ${f.data.fixed_by})` : ""}`;
  defWrite(finding, "add", "Bulgu kaydı oluşturur (varsayılan open)", (o: Opts) => {
    const f = addFinding({
      project: o.project as string, severity: o.severity as string, source: o.source as string, title: o.title as string,
      detail: o.detailFile ? readInput(o.detailFile as string) : undefined, state: o.state as string | undefined,
    });
    out(o, { id: f.data.id }, f.data.id);
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
    });
    out(
      o,
      { findings: findings.map((f) => ({ ...f.data, detail: f.body.replace(/^## Ayrıntı\n?/, "").trim() })), warnings },
      [...findings.map(findingLine), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
    );
  })
    .option("--project <slug>", "proje slug'ı")
    .option("--state <durumlar>", `virgülle ayrılmış: ${STATES.join(", ")}`)
    .option("--severity <önemler>", `virgülle ayrılmış: ${SEVERITIES.join(", ")}`);
  defWrite(finding, "set <id> <state>", "Bulgunun durumunu değiştirir", (id: string, state: string, o: Opts) => {
    const f = setFindingState(id, state, o.by as string | undefined);
    out(o, { id, state: f.data.state, fixed_by: f.data.fixed_by ?? null }, `${id} -> ${f.data.state}`);
  }).option("--by <görev>", "düzelten görev (yalnızca fixed)");
}
