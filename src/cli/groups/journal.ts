import type { Command } from "commander";
import { readInput } from "../../kb/input.js";
import { appendJournal, getJournal } from "../../kb/index.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerJournal(program: Command, k: Kit): void {
  const { out, def } = k;
  const journal = program.command("journal").description("Günlük");
  def(journal, "append <tarih>", "kb/journal/<tarih>.md'ye ekler", (date: string, o: Opts) => {
    appendJournal(date, readInput(o.file as string));
    out(o, { date }, `günlüğe eklendi: ${date}`);
  }).requiredOption("--file <md>", "içerik (- = stdin)");

  def(journal, "get <tarih>", "kb/journal/<tarih>.md içeriğini proje bölümleriyle döner (salt okuma)", (date: string, o: Opts) => {
    const j = getJournal(date);
    out(o, j, j.content);
  });
}
