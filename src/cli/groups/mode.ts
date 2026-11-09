import type { Command } from "commander";
import { expireMode, modeLine, modeStatus, assertNotWorker, setNight, setOff, setWatch } from "../../mode/store.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerMode(program: Command, k: Kit): void {
  const { out, def } = k;
  const mode = program.command("mode").description("Gece / bekçi modu (yetki penceresi kb/mode.json)");
  const modeText = (now: Date) => modeLine(now) ?? "mod kapalı";
  def(mode, "night", "Gece (yetki) modunu açar: pencere boyunca faz ve son kapı merge'ü sormadan", (o: Opts) => {
    assertNotWorker();
    const split = (v: unknown) => (v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : undefined);
    const night = setNight({
      until: o.until as string | undefined, note: o.note as string | undefined, projects: split(o.projects),
      untilTasks: split(o.untilTask), push: o.push === true, except: split(o.except),
    });
    out(o, { night }, modeText(new Date()));
  })
    .option("--until <HH:MM|ISO>", "bitiş: sıradaki HH:MM ya da ISO tarih-saat (en çok 24 saat)")
    .option("--until-task <id,...>", "listedeki görevler done/cancelled olunca pencere kapanır (--until ile: hangisi önce; tek başına: 24 saat tavan)")
    .option("--push", "master/main merge+push yetkisi (yalnız gate/CI yeşil ve açık P1 yokken)")
    .option("--except <a,b>", "yetkinin açmadığı eylem sınıfları; deploy,backfill,keychain her zaman istisnadır")
    .option("--projects <a,b>", "yetkinin geçtiği projeler (boş = hepsi)")
    .option("--note <metin>", "kullanıcının verdiği kapsam notu");
  def(mode, "watch <on|off>", "Bekçi modu: gece modundan bağımsız aç/kapat", (v: string, o: Opts) => {
    if (v !== "on" && v !== "off") throw new Error("on ya da off ver");
    assertNotWorker();
    const dropped = setWatch(v === "on");
    out(o, { ...modeStatus(new Date()), dropped }, modeText(new Date()) + (dropped ? " (dolmuş gece penceresi düşürüldü)" : ""));
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
