import type { Command } from "commander";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../../kb/index.js";
import { sessionFile, sessionName } from "../../kb/session.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerSession(program: Command, k: Kit): void {
  const { out, def } = k;
  const session = program.command("session").description("VLAD oturum adı");
  def(session, "register <ad>", "Oturum adını kb/vlad-session.txt'ye yazar", (name: string, o: Opts) => {
    if (!name.trim()) throw new Error("oturum adı boş olamaz");
    const file = sessionFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, name.trim() + "\n");
    out(o, { name: name.trim() }, `kaydedildi: ${name.trim()}`);
  });
  def(session, "name", "Kayıtlı oturum adını yazar", (o: Opts) => {
    const name = sessionName(); // uzak işçide VLAD_SESSION (beyin adı) dosyadan önce gelir (F-vlad-199)
    if (!name) throw new Error("oturum kaydı yok; önce `vlad session register <ad>`");
    out(o, { name }, name);
  });
}
