import type { Command } from "commander";
import { def, out, readInput, type Opts } from "../cli-util.js";
import { loadConfig } from "../kb/index.js";
import { addProjectNote, listProjectsWithWarnings, setProjectField, writeProject } from "../projects/store.js";
import { scanRootsWithWarnings } from "../scan/scan.js";

export function registerProject(program: Command): void {
  def(program, "scan", "Kök klasörleri tara (kart yazmaz)", (o: Opts) => {
    const { repos, warnings } = scanRootsWithWarnings(loadConfig());
    out(
      o,
      { repos, warnings },
      [...repos.map((r) => `${r.slug}  ${r.path}${r.hasCard ? "" : "  (kart yok)"}`), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
    );
  });

  const project = program.command("project").description("Proje kartları");
  def(project, "write <slug>", "Kartı doğrulayıp yazar", (slug: string, o: Opts) => {
    const card = writeProject(slug, readInput(o.file as string));
    out(o, { slug: card.slug }, `yazıldı: ${card.slug}`);
  }).requiredOption("--file <md>", "kart dosyası (- = stdin)");
  def(project, "set <slug> <field> <value>", "Tek kart alanını yazar (exposure|repo|default_branch|local_only|local_only_reason|gate); boş değer alanı siler", (slug: string, field: string, value: string, o: Opts) => {
    setProjectField(slug, field, value);
    out(o, { slug, field, value: value === "" ? null : value }, value === "" ? `silindi: ${slug}.${field}` : `yazıldı: ${slug}.${field}=${value}`);
  });
  def(project, "note <slug> [not]", "Karta `## Çalışma notları` altına tarihli not ekler (--file: çok satırlı, - = stdin)", (slug: string, note: string | undefined, o: Opts) => {
    const text = o.file ? readInput(o.file as string) : note ?? "";
    const line = addProjectNote(slug, text);
    out(o, { slug, note: line }, `not eklendi: ${slug}`);
  }).option("--file <md>", "not dosyası (- = stdin)");
  def(project, "list", "Kartları listeler", (o: Opts) => {
    const { projects, warnings } = listProjectsWithWarnings();
    out(
      o,
      { projects, warnings },
      [...projects.map((p) => `${p.slug}  ${p.status}  ${p.path}${p.exposure ? `  [${p.exposure}]` : ""}${p.gate ? `  gate: ${p.gate}` : ""}`), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
    );
  });
}
