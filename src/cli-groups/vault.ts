import type { Command } from "commander";
import { def, out, type Opts } from "../cli-util.js";
import { DEFAULT_LIMIT, VaultError, ZONES, listVault, readVault, searchVault } from "../vault/search.js";

/** Only VaultError text reaches the user; anything else (fs errors with absolute paths) is generic. */
function vdef(parent: Command, spec: string, desc: string, fn: (...a: any[]) => void): Command {
  return def(parent, spec, desc, (...args: any[]) => {
    try {
      fn(...args);
    } catch (e) {
      throw e instanceof VaultError ? e : new VaultError("okunamadı");
    }
  });
}

export function registerVault(program: Command): void {
  const vault = program.command("vault").description("Vault okuma (salt okunur): kb/ ve vault/docs/");
  vdef(vault, "search <sorgu>", "Düz metin arama (büyük/küçük harf ve Türkçe İ/ı duyarsız), skora göre sıralı", (q: string, o: Opts) => {
    const { hits, truncated } = searchVault(q, { zone: o.zone as string | undefined, limit: o.limit === undefined ? undefined : Number(o.limit), stripFrontMatter: !!o.stripFrontMatter });
    out(o, { hits, truncated }, [...hits.map((h) => `${h.path}:${h.line}  (${h.score})  ${h.snippet}`), ...(truncated ? ["(kısmi sonuç: arama bütçesi aşıldı)"] : [])].join("\n"));
  })
    .option("--zone <bölge>", ZONES.join(" | "))
    .option("--limit <n>", `en çok sonuç (varsayılan ${DEFAULT_LIMIT})`)
    .option("--strip-front-matter", "başlangıçtaki YAML front matter aranmaz/döndürülmez (API bunu kullanır)");
  vdef(vault, "read <yol>", "İzin listesindeki bir .md dosyasını (ya da yalnız bir başlık bölümünü) okur", (path: string, o: Opts) => {
    const f = readVault(path, o.heading as string | undefined, { stripFrontMatter: !!o.stripFrontMatter });
    out(o, f, f.content);
  })
    .option("--heading <başlık>", "yalnız bu başlığın bölümünü döndür")
    .option("--strip-front-matter", "başlangıçtaki YAML front matter döndürülmez (API bunu kullanır)");
  vdef(vault, "ls [dizin]", "İzin listesindeki dizini listeler (dizin yoksa kökler)", (dir: string | undefined, o: Opts) => {
    const { entries, truncated } = listVault(dir);
    out(o, { entries, truncated }, [...entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)), ...(truncated ? ["(kısmi liste)"] : [])].join("\n"));
  });
}
