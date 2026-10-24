import type { Command } from "commander";
import { def, out, type Opts } from "../cli-util.js";
import { DEFAULT_LIMIT, ZONES, listVault, readVault, searchVault } from "../vault/search.js";

export function registerVault(program: Command): void {
  const vault = program.command("vault").description("Vault okuma (salt okunur): kb/ ve vault/docs/");
  def(vault, "search <sorgu>", "Düz metin arama (büyük/küçük harf ve Türkçe İ/ı duyarsız), skora göre sıralı", (q: string, o: Opts) => {
    const hits = searchVault(q, { zone: o.zone as string | undefined, limit: o.limit === undefined ? undefined : Number(o.limit) });
    out(o, { hits }, hits.map((h) => `${h.path}:${h.line}  (${h.score})  ${h.snippet}`).join("\n"));
  })
    .option("--zone <bölge>", ZONES.join(" | "))
    .option("--limit <n>", `en çok sonuç (varsayılan ${DEFAULT_LIMIT})`);
  def(vault, "read <yol>", "İzin listesindeki bir .md dosyasını (ya da yalnız bir başlık bölümünü) okur", (path: string, o: Opts) => {
    const f = readVault(path, o.heading as string | undefined);
    out(o, f, f.content);
  }).option("--heading <başlık>", "yalnız bu başlığın bölümünü döndür");
  def(vault, "ls [dizin]", "İzin listesindeki dizini listeler (dizin yoksa kökler)", (dir: string | undefined, o: Opts) => {
    const entries = listVault(dir);
    out(o, { entries }, entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)).join("\n"));
  });
}
