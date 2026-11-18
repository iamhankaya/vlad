import type { Command } from "commander";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

/**
 * SÖZLEŞME iskeleti (T20261119-20; gövdeler uygulama fazında): spc köprüsü CLI'ı.
 * `pull`: kb yazma kilidi (manifest lock "outer"), çalışan reddedilir; çekirdek `src/monitor/pull.ts`. `status`: salt okuma.
 * `install|uninstall`: launchd (`src/monitor/launchd.ts`, dinamik import), TTY + mod yetkisi (`approver install` deseni).
 */
const todo = (name: string) => (): never => { throw new Error(`not implemented: monitor ${name}`); };

export function registerMonitor(program: Command, k: Kit): void {
  const { def } = k;
  const monitor = program.command("monitor").description("spc köprüsü: sunucu alarmlarını görev olarak çeker (yalnız macOS)");
  def(monitor, "pull", "Ajanlardan alarmları çeker; critical firing için görev açar, resolved için not düşer", (_o: Opts) => todo("pull")())
    .option("--server <ad>", "yalnız bu sunucu")
    .option("--dry-run", "yazma yok; ne yapacağını döker");
  def(monitor, "status", "İmleç, son başarı, ardışık hata, açık eşlemeler ve servis durumu (salt okuma)", (_o: Opts) => todo("status")());
  def(monitor, "install", "5 dk'lık launchd servisini kurar (terminalde, mod yetkisiyle)", (_o: Opts) => todo("install")());
  def(monitor, "uninstall", "launchd servisini kaldırır (terminalde, mod yetkisiyle)", (_o: Opts) => todo("uninstall")());
}
