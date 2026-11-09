import type { Command } from "commander";
import { join } from "node:path";
import { checkKb, kbCheckExitCode } from "../../kb/check.js";
import { commitKb } from "../../kb/commit.js";
import { formatLint, lintExitCode, lintKb } from "../../audit/lint.js";
import { writeLintCache } from "../../audit/lint-cache.js";
import { formatRefs, refsOf } from "../../kb/refs.js";
import { getKbRecord, maintainKb, searchKb } from "../../kb/index.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerKb(program: Command, k: Kit): void {
  const { out, def } = k;
  const kb = program.command("kb").description("Hafıza deposu");
  def(kb, "commit <mesaj>", "kb/ altındaki değişiklikleri `kb: <mesaj>` olarak commit'ler (kod dahil edilmez)", (msg: string, o: Opts) => {
    const r = commitKb(msg, { push: !!o.push });
    const lines = [r.committed ? `commit: ${r.sha}` : "kb'de değişiklik yok"];
    if (r.pushed) lines.push("push edildi");
    if (r.warning) lines.push(`uyarı: ${r.warning}`);
    out(o, r, lines.join("\n"));
  }).option("--push", "upstream'e push eder (yalnızca push edilmemiş commit'lerin hepsi kb/ ise)");
  def(kb, "maintain", "kb bakımı: decisions.md'yi projelere böler, eski kapalı görev/bulguları archive/'e taşır (silme yok)", (o: Opts) => {
    const days = o.days === undefined ? undefined : Number(o.days);
    if (days !== undefined && !(days >= 0)) throw new Error(`geçersiz --days: ${o.days}`);
    const r = maintainKb({ days, dryRun: !!o.dryRun });
    const verb = r.dry_run ? "taşınacak" : "taşındı";
    const lines = [
      ...(r.dry_run ? ["DRY-RUN: hiçbir dosya değişmedi"] : []),
      ...r.decisions.map((d) => `karar: decisions/${d.file}.md ← ${d.blocks} blok`),
      ...r.tasks.map((t) => `görev ${verb}: ${t.from} -> ${t.to}`),
      ...r.findings.map((f) => `bulgu ${verb}: ${f.from} -> ${f.to}`),
      ...r.ideas.map((f) => `fikir ${verb}: ${f.from} -> ${f.to}`),
      ...r.gitignore_added.map((g) => `.gitignore: ${g} eklen${r.dry_run ? "ecek" : "di"}`),
    ];
    out(o, r, lines.length ? lines.join("\n") : "yapılacak bakım yok");
  }).option("--days <n>", "bu kadar günden eski kapalı kayıtlar arşivlenir (varsayılan 30)")
    .option("--dry-run", "hiçbir şeye dokunmadan yapılacakları göster");
  def(kb, "get <id>", "Görev (T…), bulgu (F-…) ya da fikri (I-…) ID ile okur; arşivdekini de bulur, gerçek yolu verir", (id: string, o: Opts) => {
    const r = getKbRecord(id, o.section as string | undefined);
    out(o, r, `${r.file}${r.archived ? " (arşiv)" : ""}\n\n${r.content}`);
  }).option("--section <başlık>", "yalnız bu `## ` bölümünü döndür (ör. \"## Kapanış raporu\")");
  def(kb, "search <sorgu>", "Sınırlı kb araması (görev bölümü, bulgu, fikir, karar bloğu, günlük bölümü; arşiv dahil); tüm kelimeler geçmeli", (query: string, o: Opts) => {
    const hits = searchKb({ query, project: o.project as string | undefined, type: o.type as string | undefined, limit: o.limit === undefined ? undefined : Number(o.limit) });
    out(o, { hits }, hits.map((h) => `${h.id}  ${h.type}  ${h.status ?? "-"}  ${h.date ?? "-"}${h.section ? `  ${h.section}` : ""}\n  ${h.snippet}\n  ${h.path}`).join("\n") || "eşleşme yok");
  })
    .option("--project <slug>", "yalnız bu proje")
    .option("--type <tür>", "task | finding | idea | decision | journal")
    .option("--limit <n>", "en çok bu kadar sonuç", "8");
  def(kb, "refs <id>", "ID'ye (T…, F-…, I-…, D-…) atıf yapan kayıtları bölüm/durum/tarihle, ilgili commit'leri ve çelişki işaretlerini listeler", (id: string, o: Opts) => {
    const r = refsOf(id);
    out(o, r, formatRefs(r));
  });
  def(kb, "lint", "Salt okuma çelişki denetimi: kart/karar/hafıza metinlerindeki T…/F-…/D-… atıflarını gerçek kayıtla karşılaştırır (işaret varsa 0, --strict'te 1)", (o: Opts) => {
    const r = lintKb({ project: o.project as string | undefined });
    if (!o.project) writeLintCache(r); // a whole-kb run feeds `status --summary` (kbLint)
    out(o, r, formatLint(r));
    process.exitCode = lintExitCode(r, !!o.strict);
  }).option("--project <slug>", "yalnız bu proje")
    .option("--strict", "işaret varsa 1 ile çık");
  def(kb, "check", "kb remote'unda `kb:` öneki taşımayan (yabancı) ve CLAUDE.md/.claude/.github'a dokunan commit'leri listeler", (o: Opts) => {
    const r = checkKb({ ack: o.ack as string | undefined });
    const lines = r.foreign.length
      ? [`yabancı commit: ${r.foreign.length}`, ...r.foreign.map((c) => `${c.sha} ${c.author}: ${c.subject}`)]
      : ["yabancı commit yok"];
    if (r.suspicious.length) lines.push(`şüpheli dosya değişikliği: ${r.suspicious.length}`, ...r.suspicious.map((c) => `${c.sha} ${c.author}: ${c.subject} [${c.files.join(", ")}]`));
    for (const w of r.warnings ?? []) lines.push(`uyarı: ${w}`);
    out(o, r, lines.join("\n"));
    process.exitCode = kbCheckExitCode(r, !!o.strict);
  }).option("--ack <sha>", "görüldü say: doğrulanan noktayı `check` çıktısındaki head'e ilerletir (sonradan gelenler işaretlenmez)")
    .option("--strict", "yabancı/şüpheli commit varsa ya da kontrol yapılamadıysa 1 ile çık");
}
