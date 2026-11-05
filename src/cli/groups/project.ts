import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readInput } from "../../kb/input.js";
import { kbPaths, loadConfig } from "../../kb/index.js";
import { projectStatus, setProjectSummary } from "../../projects/status.js";
import { refreshAllProjects, refreshProject } from "../../projects/derived.js";
import { addProjectNote, listProjectsWithWarnings, setProjectField, writeProject } from "../../projects/store.js";
import { scanRootsWithWarnings } from "../../scan/scan.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerProject(program: Command, k: Kit): void {
  const { out, def } = k;
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
  def(project, "set <slug> <field> <value>", "Tek kart alanını yazar (exposure|repo|default_branch|local_only|local_only_reason|gate|machines); boş değer alanı siler", (slug: string, field: string, value: string, o: Opts) => {
    setProjectField(slug, field, value);
    out(o, { slug, field, value: value === "" ? null : value }, value === "" ? `silindi: ${slug}.${field}` : `yazıldı: ${slug}.${field}=${value}`);
  });
  def(project, "note <slug> [not]", "Karta `## Çalışma notları` altına tarihli not ekler (--file: çok satırlı, - = stdin)", (slug: string, note: string | undefined, o: Opts) => {
    const text = o.file ? readInput(o.file as string) : note ?? "";
    const line = addProjectNote(slug, text);
    out(o, { slug, note: line }, `not eklendi: ${slug}`);
  }).option("--file <md>", "not dosyası (- = stdin)");
  def(project, "status <slug>", "Proje durum özeti: kayıtlardan üretilen sayılar/listeler + kartın `## Durum özeti` anlatısı (güncel/bayat/yok)", (slug: string, o: Opts) => {
    const s = projectStatus(slug);
    const lines = [
      `${s.slug}  ${s.status}${s.gate ? `  gate: ${s.gate}` : ""}`,
      `özet: ${s.summary.state}${s.summary.as_of ? ` (${s.summary.as_of} tarihine kadar)` : ""}${s.summary.newer.length ? `  yeni kayıt: ${s.summary.newer.join(", ")}` : ""}`,
      ...(s.summary.text ? ["", s.summary.text] : []),
      "",
      `görevler: ${Object.entries(s.tasks.counts).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`,
      ...s.tasks.active.map((t) => `  ${t.id}  ${t.state}  ${t.title}`),
      ...(s.tasks.last_done ? [`son done: ${s.tasks.last_done.id}  ${s.tasks.last_done.title}`] : []),
      `açık bulgu: ${Object.entries(s.findings.counts).map(([k, v]) => `${k}=${v}`).join(" ") || "yok"}`,
      ...s.findings.open.map((f) => `  ${f.id}  ${f.severity}  ${f.state}  ${f.title}`),
      `geçerli karar: ${s.decisions.total}${s.decisions.total > s.decisions.recent.length ? ` (son ${s.decisions.recent.length}; tümü: vlad decision list --project ${s.slug})` : ""}`,
      ...s.decisions.recent.map((d) => `  ${d.id}  ${d.date}  ${d.title}${d.expired ? `  (süresi doldu: ${d.until})` : ""}`),
      ...(s.decisions.expired.length ? [`süresi dolmuş geçerli karar: ${s.decisions.expired.join(", ")} (yenile ya da vlad decision set <id> geçersiz)`] : []),
    ];
    out(o, s, lines.join("\n"));
  });
  def(project, "summary <slug>", "Kartın `## Durum özeti` bölümünü yazar (/digest); ilk satıra 'Güncel' damgası eklenir", (slug: string, o: Opts) => {
    const stamp = setProjectSummary(slug, readInput(o.file as string));
    out(o, { slug, as_of: stamp }, `özet yazıldı: ${slug} (${stamp})`);
  }).requiredOption("--file <md>", "özet metni (- = stdin); en çok ~1000 token");
  def(project, "refresh [slug]", "Kartın koddan üretilen bloklarını (açık bulgular, Son aktivite) yeniden üretir; blok dışı metne dokunmaz", (slug: string | undefined, o: Opts) => {
    if (o.all) {
      const r = refreshAllProjects();
      out(o, r, [`tazelendi: ${r.refreshed.join(", ") || "(değişen yok)"}`, ...r.warnings.map((w) => `uyarı: ${w}`)].join("\n"));
      return;
    }
    if (!slug) throw new Error("proje slug'ı ya da --all gerekli");
    if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(join(kbPaths().projects, `${slug}.md`))) throw new Error(`proje kartı bulunamadı: ${slug}`);
    const changed = refreshProject(slug);
    out(o, { slug, changed }, changed ? `tazelendi: ${slug}` : `güncel: ${slug}`);
  }).option("--all", "tüm kartlar");
  def(project, "list", "Kartları listeler", (o: Opts) => {
    const { projects, warnings } = listProjectsWithWarnings();
    out(
      o,
      { projects, warnings },
      [...projects.map((p) => `${p.slug}  ${p.status}  ${p.path}${p.exposure ? `  [${p.exposure}]` : ""}${p.gate ? `  gate: ${p.gate}` : ""}`), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
    );
  });
}
