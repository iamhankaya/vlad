import type { Command } from "commander";
import { def, defWrite, out, type Opts } from "../cli-util.js";
import { CARD_ACTION_KINDS } from "../kb/index.js";
import { addCard, answerCard, getCard, KINDS, listCardsWithWarnings, parseFilter, resolveCard, STATES, type Card } from "../cards/store.js";

const cardLine = (c: Card) => `${c.data.id}  ${c.data.state.padEnd(9)} ${c.data.kind.padEnd(14)} ${c.data.project}  ${c.data.title}`;

function parseOption(raw: string, prev: { id: string; label: string }[] = []): { id: string; label: string }[] {
  const i = raw.indexOf("=");
  if (i < 1) throw new Error(`geçersiz --option: "${raw}" (biçim: id=Etiket)`);
  return [...prev, { id: raw.slice(0, i), label: raw.slice(i + 1) }];
}

export function registerCard(program: Command): void {
  const card = program.command("card").description("Karar kartı (mobil: senden beklenenler)");
  defWrite(card, "new", "Kart oluşturur (state open)", (o: Opts) => {
    const hasAction = o.actionKind !== undefined || o.repo !== undefined;
    const extras = ["pr", "base", "ref", "sha"].filter((k) => o[k] !== undefined);
    if (!hasAction && extras.length) throw new Error(`--${extras.join("/--")} yalnız --action-kind ve --repo ile verilir`);
    if (hasAction && (o.actionKind === undefined || o.repo === undefined)) throw new Error("action için --action-kind ve --repo birlikte gerekli");
    const c = addCard({
      kind: o.kind as string, project: o.project as string, title: o.title as string, task: o.task as string | undefined,
      options: o.option as { id: string; label: string }[] | undefined,
      action: hasAction
        ? {
            kind: o.actionKind as string, repo: o.repo as string,
            ...(o.sha ? { sha: o.sha as string } : {}),
            ...(o.pr !== undefined ? { pr: Number(o.pr) } : {}),
            ...(o.base ? { base: o.base as string } : {}), ...(o.ref ? { ref: o.ref as string } : {}),
          }
        : undefined,
    });
    out(o, { id: c.data.id }, c.data.id);
  })
    .requiredOption("--kind <tür>", KINDS.join(" | "))
    .requiredOption("--project <slug>", "proje slug'ı")
    .requiredOption("--title <başlık>", "kart başlığı")
    .option("--task <id>", "ilgili görev ID'si")
    .option("--option <id=etiket>", "seçenek (tekrarlanabilir)", parseOption)
    .option("--action-kind <tür>", `yalnız action_request: ${CARD_ACTION_KINDS.join(" | ")}`)
    .option("--sha <sha>", "yalnız action_request: 40 haneli hex commit (zorunlu)")
    .option("--repo <owner/ad>", "yalnız action_request: projenin kayıtlı repo'su olmalı")
    .option("--pr <no>", "yalnız action_request: PR numarası")
    .option("--base <branch>", "yalnız action_request: taban branch")
    .option("--ref <ref>", "yalnız action_request: ref");
  def(card, "list", "Kartları listeler", (o: Opts) => {
    const { cards, warnings } = listCardsWithWarnings({
      project: o.project as string | undefined,
      state: o.state ? parseFilter(String(o.state), STATES, "durum") : undefined,
      kind: o.kind ? parseFilter(String(o.kind), KINDS, "tür") : undefined,
    });
    out(o, { cards: cards.map((c) => c.data), warnings }, [...cards.map(cardLine), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"));
  })
    .option("--project <slug>", "proje slug'ı")
    .option("--state <durumlar>", `virgülle ayrılmış: ${STATES.join(", ")}`)
    .option("--kind <türler>", `virgülle ayrılmış: ${KINDS.join(", ")}`);
  def(card, "show <id>", "Tek kartı gösterir", (id: string, o: Opts) => {
    const c = getCard(id);
    out(o, c.data, cardLine(c));
  });
  defWrite(card, "answer <id>", "Açık kartı cevaplar (yalnız bir kez)", (id: string, o: Opts) => {
    const c = answerCard(id, { option: o.option as string | undefined, text: o.text as string | undefined, by_device: o.byDevice as string });
    out(o, c.data, `${id} cevaplandı`);
  })
    .option("--option <id>", "seçilen seçenek")
    .option("--text <metin>", "serbest metin cevap")
    // trust boundary: the CLI cannot verify this value. Only the API (verified signed envelope) may supply it; never forward client input.
    .requiredOption("--by-device <id>", "cevaplayan cihaz (DOĞRULANMAZ: yalnız API'nin doğrulanmış zarfından gelmeli)");
  defWrite(card, "resolve <id>", "Açık kartı kapatır", (id: string, o: Opts) => {
    const c = resolveCard(id, o.dismiss ? "dismissed" : "resolved");
    out(o, { id, state: c.data.state }, `${id} -> ${c.data.state}`);
  }).option("--dismiss", "resolved yerine dismissed");
}
