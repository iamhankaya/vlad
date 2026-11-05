import type { Command } from "commander";
import { join } from "node:path";
import { listInboxWithWarnings, markDone } from "../../inbox/inbox.js";
import { addPending, donePending, listPending } from "../../digest/pending.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerInbox(program: Command, k: Kit): void {
  const { out, def } = k;
  const inbox = program.command("inbox").description("Oturum raporları");
  def(inbox, "list", "İşlenmemiş raporlar", (o: Opts) => {
    const { items, warnings } = listInboxWithWarnings();
    out(
      o,
      { items, warnings },
      [...items.map((i) => `${i.file}  ${i.record.project ?? "-"}  ${i.record.reason}`), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
    );
  });
  def(inbox, "count", "İşlenmemiş rapor sayısı", (o: Opts) => {
    const count = listInboxWithWarnings().items.length;
    out(o, { count }, String(count));
  });
  def(inbox, "done <dosyalar...>", "Raporları processed/'a taşır", (files: string[], o: Opts) => {
    markDone(files);
    out(o, { moved: files }, `${files.length} rapor taşındı`);
  });

  const digestCmd = program.command("digest").description("Digest yardımcıları");
  const pendingCmd = digestCmd.command("pending").description("Onay bekleyen digest maddeleri (otomatik digest, D-vlad-061)");
  const pendingLine = (i: { id: string; state: string; task: string | null; project: string | null; text: string }) =>
    `${i.id}  ${i.state}  ${i.project ?? "-"}  ${i.task ?? "-"}  ${i.text}`;
  def(pendingCmd, "add", "Kullanıcı onayı bekleyen digest maddesi ekler", (o: Opts) => {
    const i = addPending({ text: o.text as string, task: o.task as string | undefined, project: o.project as string | undefined });
    out(o, { id: i.id, item: i }, i.id);
  })
    .requiredOption("--text <metin>", "madde metni")
    .option("--task <id>", "ilgili görev ID'si")
    .option("--project <slug>", "ilgili proje");
  def(pendingCmd, "list", "Açık maddeleri listeler (--all: kapalılar dahil)", (o: Opts) => {
    const items = listPending(o.all === true);
    out(o, { items }, items.map(pendingLine).join("\n"));
  }).option("--all", "kapalı maddeleri de göster");
  def(pendingCmd, "done <id>", "Maddeyi kapatır (kullanıcı karar verdi / işlendi)", (id: string, o: Opts) => {
    const i = donePending(id, o.note as string | undefined);
    out(o, { item: i }, `${i.id} kapatıldı`);
  }).option("--note <metin>", "kapanış notu (karar/sonuç)");
}
