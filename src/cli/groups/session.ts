import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kbPaths, writeFileAtomic } from "../../kb/index.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerSession(program: Command, k: Kit): void {
  const { out, def } = k;
  const sessionFile = () => join(kbPaths().kb, "vlad-session.txt");
  const session = program.command("session").description("VLAD oturum adı");
  def(session, "register <ad>", "Oturum adını kb/vlad-session.txt'ye yazar", (name: string, o: Opts) => {
    if (!name.trim()) throw new Error("oturum adı boş olamaz");
    const file = sessionFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, name.trim() + "\n");
    out(o, { name: name.trim() }, `kaydedildi: ${name.trim()}`);
  });
  def(session, "name", "Kayıtlı oturum adını yazar", (o: Opts) => {
    const file = sessionFile();
    if (!existsSync(file)) throw new Error("oturum kaydı yok; önce `vlad session register <ad>`");
    const name = readFileSync(file, "utf8").trim();
    out(o, { name }, name);
  });
}
