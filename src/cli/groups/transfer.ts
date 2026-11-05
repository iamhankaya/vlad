import type { Command } from "commander";

import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerTransfer(program: Command, k: Kit): void {
  const { ctx, out, def } = k;
  // --- aktarim:S --- vlad send / vlad clip (ince kabuk; gövde src/transfer/cli.ts ve src/clip/cli.ts)
  def(program, "send [yol...]", "Dosya/klasörleri karşı makinenin İndirilenler klasörüne gönderir (--to: makine; 2'den çok makinede zorunlu)", async (paths: string[], o: Opts) => {
    const { runSendCommand, argsFromEnv } = await import("../../transfer/cli.js");
    if (o.argsEnv) paths = argsFromEnv(); else if (!paths?.length) throw new Error("gönderilecek yol verilmedi (<yol...> ya da --args-env)");
    await runSendCommand(paths, { to: o.to as string | undefined, json: !!o.json, notify: !!o.notify, isTTY: !!(ctx.stderr as NodeJS.WriteStream).isTTY });
  }).option("--to <makine>", "hedef makine").option("--notify", "sonucu (başarı/hata) bildirimle de göster").option("--args-env", "yolları VLAD_ARG_COUNT/VLAD_ARG_<n> ortam değişkenlerinden al (sağ tık başlatıcısı)");
  const clip = program.command("clip").description("Ortak pano (Mac↔Windows)");
  def(clip, "on", "Pano eşitlemeyi açar", async (o: Opts) => { await (await import("../../clip/cli.js")).runClip("on", { json: !!o.json }); });
  def(clip, "off", "Pano eşitlemeyi kapatır", async (o: Opts) => { await (await import("../../clip/cli.js")).runClip("off", { json: !!o.json }); });
  def(clip, "status", "Pano eşitleme durumu (enabled, agentRunning)", async (o: Opts) => { await (await import("../../clip/cli.js")).runClip("status", { json: !!o.json }); });
  def(clip, "get", "Yerel panoyu okur (resim varsa --out <png>)", async (o: Opts) => {
    await (await import("../../clip/cli.js")).runClip("get", { json: !!o.json, out: o.out as string | undefined });
  }).option("--out <png>", "resim panosunu bu PNG dosyasına yaz");
  def(clip, "set [metin]", "Yerel panoya yazar (metin, --file <yol|->, ya da --image <png>)", async (text: string | undefined, o: Opts) => {
    await (await import("../../clip/cli.js")).runClip("set", { json: !!o.json, text, file: o.file as string | undefined, image: o.image as string | undefined });
  }).option("--file <yol>", "metni dosyadan (- = stdin) oku").option("--image <png>", "PNG dosyasını panoya yaz");
  // --- /aktarim:S ---
}
