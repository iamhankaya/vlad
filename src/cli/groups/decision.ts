import type { Command } from "commander";
import { join } from "node:path";
import { readInput } from "../../kb/input.js";
import { addDecision, listDecisions, isDecisionExpired, migrateDecisions, setDecisionStatus, DECISION_STATUSES } from "../../kb/index.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerDecision(program: Command, k: Kit): void {
  const { out, def } = k;
  const decision = program.command("decision").description("Karar günlüğü");
  def(decision, "add", "kb/decisions/<proje>.md'ye karar ekler; D-<proje>-NNN ID'si döner", (o: Opts) => {
    const id = addDecision({
      project: o.project as string,
      title: o.title as string,
      body: readInput(o.bodyFile as string),
      source: o.source as string | undefined,
      supersedes: o.supersedes as string | undefined,
      until: o.until as string | undefined,
    });
    out(o, { ok: true, id }, `karar eklendi: ${id}`);
  })
    .requiredOption("--project <slug>", "proje")
    .requiredOption("--title <başlık>", "başlık")
    .requiredOption("--body-file <md>", "gövde (- = stdin)")
    .option("--source <kaynak>", "session/görev kaynağı")
    .option("--supersedes <id>", "bu kararın yerine geçtiği karar (o yerine-geçti olur)")
    .option("--until <tarih>", "kararın son tarihi (YYYY-MM-DD ya da YYYY-MM-DDTHH:MM); geçince status/kb lint süresi dolmuş geçerli karar olarak işaretler");
  def(decision, "list", "Kararları kısa listeler (varsayılan yalnız geçerli)", (o: Opts) => {
    const decisions = listDecisions({ project: o.project as string | undefined, all: !!o.all }).map(({ path: _p, ...d }) => d); // paths are for `kb search`; they only bloat a list
    out(o, { decisions }, decisions.map((d) => `${d.id}  ${d.date}  ${d.status}  ${d.title}${d.superseded_by ? `  -> ${d.superseded_by}` : ""}${d.until ? `  (süre: ${d.until}${isDecisionExpired(d) ? ", doldu" : ""})` : ""}`).join("\n"));
  })
    .option("--project <slug>", "yalnız bu proje (genel kararlar: genel)")
    .option("--all", "geçersiz ve yerine geçilmiş kararlar da");
  def(decision, "set <id> <durum>", `Kararın durumunu değiştirir (${DECISION_STATUSES.join(" | ")})`, (id: string, status: string, o: Opts) => {
    setDecisionStatus(id, status, o.supersededBy as string | undefined);
    out(o, { id, status, superseded_by: (o.supersededBy as string | undefined) ?? null }, `${id} -> ${status}`);
  }).option("--superseded-by <id>", "yerine geçen karar (yerine-geçti için zorunlu)");
  def(decision, "migrate", "ID'siz eski karar bloklarına D-<proje>-NNN ve durum 'geçerli' ekler (metin silinmez, idempotent)", (o: Opts) => {
    const r = migrateDecisions({ dryRun: !!o.dryRun });
    const verb = o.dryRun ? "verilecek" : "verildi";
    out(o, { dry_run: !!o.dryRun, files: r }, r.length ? [...(o.dryRun ? ["DRY-RUN: hiçbir dosya değişmedi"] : []), ...r.map((f) => `decisions/${f.file}.md: ${f.assigned} ID ${verb}`)].join("\n") : "geçiş gerekmiyor");
  }).option("--dry-run", "hiçbir şeye dokunmadan göster");
}
