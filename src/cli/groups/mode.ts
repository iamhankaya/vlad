import type { Command } from "commander";
import { expireMode, modeLine, modeStatus, setNight, setOff, setWatch } from "../../mode/store.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerMode(program: Command, k: Kit): void {
  const { out, def } = k;
  const mode = program.command("mode").description("Gece / bekçi modu (yetki penceresi kb/mode.json)");
  const modeText = (now: Date) => modeLine(now) ?? "mod kapalı";
  def(mode, "night", "Gece (yetki) modunu açar: pencere boyunca faz ve son kapı merge'ü sormadan", (o: Opts) => {
    const night = setNight({
      until: o.until as string, note: o.note as string | undefined,
      projects: o.projects ? String(o.projects).split(",").map((x) => x.trim()).filter(Boolean) : undefined,
    });
    out(o, { night }, modeText(new Date()));
  })
    .requiredOption("--until <HH:MM|ISO>", "bitiş: sıradaki HH:MM ya da ISO tarih-saat (en çok 24 saat)")
    .option("--projects <a,b>", "yetkinin geçtiği projeler (boş = hepsi)")
    .option("--note <metin>", "kullanıcının verdiği kapsam notu");
  def(mode, "watch <on|off>", "Bekçi modu: gece modundan bağımsız aç/kapat", (v: string, o: Opts) => {
    if (v !== "on" && v !== "off") throw new Error("on ya da off ver");
    setWatch(v === "on");
    out(o, modeStatus(new Date()), modeText(new Date()));
  });
  def(mode, "off", "Gece ve bekçi modunu kapatır", (o: Opts) => {
    setOff();
    out(o, modeStatus(new Date()), "mod kapalı");
  });
  def(mode, "status", "Mod durumu (biten pencere bir kez bildirilir, sonra temizlenir)", (o: Opts) => {
    const now = new Date();
    const s = modeStatus(now);
    const line = modeText(now);
    expireMode(now);
    out(o, { ...s, line }, line);
  });
}
