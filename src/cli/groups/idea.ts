import type { Command } from "commander";
import { addIdea, fromFindings, IDEA_STATES, listIdeas, promoteIdea, setIdeaStates } from "../../ideas/store.js";
import { parseFilter } from "../../findings/store.js";
import { readInput } from "../../kb/input.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerIdea(program: Command, k: Kit): void {
  const { out, def } = k;
  const idea = program.command("idea").description("Fikir deposu (bulgulardan ayrı; kb/ideas/)");
  def(idea, "add", "Fikir kaydı oluşturur (open)", (o: Opts) => {
    const i = addIdea({
      project: o.project as string, title: o.title as string, source: o.source as string | undefined,
      detail: o.detailFile ? readInput(o.detailFile as string) : undefined,
    });
    out(o, { id: i.data.id }, i.data.id);
  })
    .requiredOption("--project <slug>", "proje slug'ı")
    .requiredOption("--title <başlık>", "fikir başlığı")
    .option("--detail-file <md>", "ayrıntı (- = stdin)")
    .option("--source <id>", "fikrin geldiği görev (T…) ya da bulgu (F-…)");
  def(idea, "list", "Fikirleri listeler", (o: Opts) => {
    const { ideas, warnings } = listIdeas({
      project: o.project as string | undefined,
      state: o.state ? parseFilter(String(o.state), IDEA_STATES, "durum") : undefined,
    });
    out(
      o,
      { ideas: ideas.map((i) => ({ ...i.data, detail: i.body.replace(/^## Ayrıntı\n?/, "").split(/^## Kapanış/m)[0]!.trim() })), warnings },
      [...ideas.map((i) => `${i.data.id}  ${i.data.state.padEnd(8)} ${i.data.title}${i.data.promoted_task ? `  (görev: ${i.data.promoted_task})` : ""}`), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
    );
  })
    .option("--project <slug>", "proje slug'ı")
    .option("--state <durumlar>", `virgülle ayrılmış: ${IDEA_STATES.join(", ")}`);
  def(idea, "set <args...>", "Fikir(ler)i bırakır: set <id...> dropped --reason \"<metin>\" (hepsi ya da hiçbiri)", (args: string[], o: Opts) => {
    if (args.length < 2) throw new Error("kullanım: idea set <id...> dropped --reason <metin>");
    const rows = setIdeaStates(args.slice(0, -1), args[args.length - 1]!, { reason: o.reason as string | undefined })
      .map((i) => ({ id: i.data.id, state: i.data.state }));
    out(o, rows.length === 1 ? rows[0]! : { updated: rows }, rows.map((r) => `${r.id} -> ${r.state}`).join("\n"));
  }).option("--reason <metin>", "gerekçe (zorunlu); fikir dosyasına ## Kapanış olarak yazılır");
  def(idea, "promote <id>", "Fikri göreve bağlar (state promoted, görev ID'si yazılır)", (id: string, o: Opts) => {
    const i = promoteIdea(id, o.task as string);
    out(o, { id: i.data.id, state: i.data.state, task: i.data.promoted_task }, `${i.data.id} -> promoted (${i.data.promoted_task})`);
  }).requiredOption("--task <id>", "fikri alan görev ID'si (T…)");
  def(idea, "from-finding <ids...>", "Bulguları fikir deposuna taşır: fikir açar, bulguyu wontfix yapar (hepsi ya da hiçbiri)", (ids: string[], o: Opts) => {
    const moved = fromFindings(ids).map((m) => ({ finding: m.finding, idea: m.idea.data.id }));
    out(o, { moved }, moved.map((m) => `${m.finding} -> ${m.idea}`).join("\n"));
  });
}
