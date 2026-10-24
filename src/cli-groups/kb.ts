import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { def, defWrite, out, readInput, type Opts } from "../cli-util.js";
import { installGlobal } from "../install.js";
import { commitKb } from "../kb/commit.js";
import { addDecision, appendJournal, getVladHome, kbPaths } from "../kb/index.js";

export function registerKb(program: Command): void {
  const decision = program.command("decision").description("Karar günlüğü");
  defWrite(decision, "add", "kb/decisions.md'ye karar ekler", (o: Opts) => {
    addDecision({
      project: o.project as string,
      title: o.title as string,
      body: readInput(o.bodyFile as string),
      source: o.source as string | undefined,
    });
    out(o, { ok: true }, "karar eklendi");
  })
    .requiredOption("--project <slug>", "proje")
    .requiredOption("--title <başlık>", "başlık")
    .requiredOption("--body-file <md>", "gövde (- = stdin)")
    .option("--source <kaynak>", "session/görev kaynağı");

  const journal = program.command("journal").description("Günlük");
  defWrite(journal, "append <tarih>", "kb/journal/<tarih>.md'ye ekler", (date: string, o: Opts) => {
    appendJournal(date, readInput(o.file as string));
    out(o, { date }, `günlüğe eklendi: ${date}`);
  }).requiredOption("--file <md>", "içerik (- = stdin)");

  const kb = program.command("kb").description("Hafıza deposu");
  defWrite(kb, "commit <mesaj>", "kb/ altındaki değişiklikleri `kb: <mesaj>` olarak commit'ler (kod dahil edilmez)", (msg: string, o: Opts) => {
    const r = commitKb(msg, { push: !!o.push });
    const lines = [r.committed ? `commit: ${r.sha}` : "kb'de değişiklik yok"];
    if (r.pushed) lines.push("push edildi");
    if (r.warning) lines.push(`uyarı: ${r.warning}`);
    out(o, r, lines.join("\n"));
  }).option("--push", "upstream'e push eder (yalnızca push edilmemiş commit'lerin hepsi kb/ ise)");

  const sessionFile = () => join(kbPaths().kb, "vlad-session.txt");
  const session = program.command("session").description("VLAD oturum adı");
  defWrite(session, "register <ad>", "Oturum adını kb/vlad-session.txt'ye yazar", (name: string, o: Opts) => {
    if (!name.trim()) throw new Error("oturum adı boş olamaz");
    const file = sessionFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, name.trim() + "\n", "utf8");
    out(o, { name: name.trim() }, `kaydedildi: ${name.trim()}`);
  }, { guard: "off" });
  def(session, "name", "Kayıtlı oturum adını yazar", (o: Opts) => {
    const file = sessionFile();
    if (!existsSync(file)) throw new Error("oturum kaydı yok; önce `vlad session register <ad>`");
    const name = readFileSync(file, "utf8").trim();
    out(o, { name }, name);
  });

  def(program, "install", "SessionEnd hook'unu ve vlad-worker skill'ini ~/.claude'a kurar", (o: Opts) => {
    const claudeDir = process.env.VLAD_CLAUDE_DIR || join(homedir(), ".claude");
    const { actions } = installGlobal({ home: getVladHome(), claudeDir, dryRun: !!o.dryRun });
    out(o, { actions }, actions.join("\n"));
  }).option("--dry-run", "hiçbir şeye dokunmadan yapılacakları göster");
}
