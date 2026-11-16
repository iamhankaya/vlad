import type { Command } from "commander";
import { expireMode, modeLine, modeStatus, setNight, setOff, setWatch } from "../../mode/store.js";
import { assertNotWorker as assertNotWorkerBase } from "../../mode/guard.js";
import { createInterface } from "node:readline/promises";
import { authorizeReset, disableKey, initKey, mintToken, requireModeAuthority } from "../../mode/token.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

/** Çalışan değil + (anahtar etkinse) geçerli VLAD_MODE_TOKEN: doğrulama CLI tarafındadır, hook'tan bağımsız (F-vlad-287). */
function assertNotWorker(): void { assertNotWorkerBase(); requireModeAuthority(); }

export function registerMode(program: Command, k: Kit): void {
  const { out, def } = k;
  const mode = program.command("mode").description("Gece / bekçi modu (yetki penceresi kb/mode.json)").enablePositionalOptions(); // `mode request` bayrakları işlemden önce (passThroughOptions)
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
    assertNotWorker();
    setOff();
    out(o, modeStatus(new Date()), "mod kapalı");
  });
  // Uzaktan onay (T20261116-04, sözleşme iskeleti; gövde U4'te). Yalnız VLAD (çalışan reddi); VLAD_MODE_TOKEN istemez, anahtar okumaz; istek approver servisine inbox/ ile gider.
  // Hata öncelik sırası: (1) çalışan, (2) geçersiz işlem/argüman, (3) approver kurulu değil, (4) servis ack'i (invalid/locked/busy/rate_limited), (5) approver yanıt vermiyor.
  def(mode, "request <op> [args...]", "Korunan işlem için telefondan onay ister (night|watch|off|install|setup): istek approver servisine yazılır, kullanıcı telefondan onaylayınca servis işlemi çalıştırır", (_op: string, _args: string[], _o: Opts) => {
    throw new Error("not implemented");
  }).passThroughOptions()
    .option("--wait", "sonuç gelene kadar bekle (varsayılan 310 sn; süre dolarsa çıkış 1, istek iptal edilmez)")
    .option("--wait-seconds <n>", "--wait süresi (saniye); isteğe bağlı değerli --wait işlem adını yuttuğu için ayrı bayrak");
  def(mode, "status", "Mod durumu (biten pencere bir kez bildirilir, sonra temizlenir)", (o: Opts) => {
    const now = new Date();
    const s = modeStatus(now);
    const line = modeText(now);
    expireMode(now);
    out(o, { ...s, line }, line);
  });
  def(mode, "token", "VLAD oturumu için imzalı mod belirteci üretir (yalnız kullanıcının terminalinde; ilk çalıştırmada anahtarı üretir)", async (o: Opts) => {
    assertNotWorkerBase();
    if (!process.stdin.isTTY) throw new Error("mode token yalnız etkileşimli terminalde (TTY) çalışır; çalışan oturumları belirteç alamaz");
    if (o.disable === true) {
      if (o.reset === true) throw new Error("--disable ile --reset birlikte verilemez");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { await authorizeReset(process.env, new Date(), (q) => rl.question(q)); } finally { rl.close(); }
      disableKey();
      out(o, { disabled: true }, "mod belirteci mekanizması kapatıldı (gizli dizin + etkinleştirme işareti silindi)");
      return;
    }
    const hours = o.ttl === undefined ? 24 : Number(o.ttl);
    if (!(hours > 0 && hours <= 72)) throw new Error("--ttl 0-72 saat arası olmalı");
    if (o.reset === true) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { await authorizeReset(process.env, new Date(), (q) => rl.question(q)); } finally { rl.close(); }
    }
    const created = initKey(o.reset === true);
    if (created) process.stderr.write("mod anahtarı üretildi (gizli dizin 0700, dosya 0600)\n");
    const token = mintToken(hours * 3_600_000);
    out(o, { token, hours }, token);
  }).option("--ttl <saat>", "belirteç ömrü (varsayılan 24, en çok 72)")
    .option("--disable", "mekanizmayı tamamen kapatır (gizli dizin + etkinleştirme işareti); geçerli VLAD_MODE_TOKEN ister, anahtar yok/bozuksa elle SIFIRLA onayı")
    .option("--reset", "anahtarı yeniden üretir (eski belirteçler ve imzalı pencere geçersiz olur); geçerli VLAD_MODE_TOKEN ister, anahtar bozuksa elle SIFIRLA onayı");
}
