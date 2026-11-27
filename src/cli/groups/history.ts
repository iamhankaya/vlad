import type { Command } from "commander";
import { loadConfig } from "../../kb/index.js";
import { getVladHome } from "../../kb/home.js";
import { historySearch, historyShow, locateHunter, type HunterDeps, type SearchOutput, type ShowOutput } from "../../history/hunter.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

/** PATH, yoksa vlad.config.json `hunterPath`; bozuk config PATH aramasını engellemez. */
function hunterDeps(): HunterDeps {
  let hunterPath: string | undefined;
  try { hunterPath = loadConfig().hunterPath; } catch { /* yalnız PATH */ }
  const { bin, tried } = locateHunter({ env: process.env, hunterPath, vladHome: getVladHome() });
  return { bin, tried };
}

const searchText = (r: SearchOutput): string => {
  const head = `${r.returned}/${r.total_hits} sonuç (${r.took_ms} ms)`;
  const rows = r.results.map((x) => `${x.id}  ${x.ts}  ${x.project}${x.task ? `/${x.task}` : ""}  ${x.role}/${x.kind}${x.tool ? `:${x.tool}` : ""}${x.source_deleted ? "  [kaynak silinmiş]" : ""}\n  ${x.snippet}`);
  return [head, ...rows].join("\n");
};

const showText = (r: ShowOutput): string => {
  const head = `${r.id}  ${r.project}${r.task ? `/${r.task}` : ""}${r.source_deleted ? "  [kaynak silinmiş]" : ""}`;
  const msgs = r.messages.map((m) => [`${m.target ? ">" : " "} ${m.line}  ${m.ts}`, ...m.blocks.map((b) => `    [${b.role}/${b.kind}${b.tool ? `:${b.tool}` : ""}] ${b.text.replace(/\n/g, "\n    ")}`)].join("\n"));
  return [head, ...msgs].join("\n");
};

/**
 * hunter kimlikleri `-Users-…/<oturum>.jsonl:<satır>` biçimindedir ve sorgu `-terim` (hariç tutma) içerebilir: komutlar
 * bilinmeyen tek tireli parçaları işlenen olarak kabul eder (allowUnknownOption). `--` ile başlayan bilinmeyen parça
 * yazım hatası sayılır (`--limt 5` sorguya karışmasın).
 */
function rejectUnknownLong(parts: string[]): void {
  const bad = parts.find((p) => p.startsWith("--"));
  if (bad) throw new Error(`bilinmeyen seçenek '${bad}'`);
}

export function registerHistory(program: Command, k: Kit): void {
  const { out, def, ctx } = k;
  const history = program.command("history").description("eski oturum kayıtlarında arama (hunter)");
  def(history, "search <sorgu...>", "Eski Claude oturum kayıtlarında arar (hunter dizini; sırlar maskeli; `-terim` hariç tutar)", (parts: string[], o: Opts) => {
    rejectUnknownLong(parts);
    const r = historySearch({
      query: parts.join(" "),
      project: o.project as string | undefined,
      task: o.task as string | undefined,
      since: o.since as string | undefined,
      until: o.until as string | undefined,
      limit: o.limit as string | undefined,
      all: !!o.all,
    }, hunterDeps());
    if (!o.json) for (const w of r.warnings) ctx.stderr.write(`uyarı: ${w}\n`);
    out(o, r, r.results.length ? searchText(r) : `eşleşme yok (${r.total_hits})`);
  })
    .option("--project <slug>", "yalnız bu proje")
    .option("--task <id>", "yalnız bu görevin worktree oturumları")
    .option("--since <YYYY-MM-DD>", "bu yerel günden (dahil)")
    .option("--until <YYYY-MM-DD>", "bu yerel güne kadar (dahil)")
    .option("--limit <n>", "en çok bu kadar sonuç (hunter varsayılanı 20)")
    .option("--all", "geçici klasör oturumlarını da içer")
    .allowUnknownOption();
  def(history, "show <id>", "Bir arama sonucunun (`<dosya>:<satır>`) çevresindeki mesajları gösterir", (id: string, o: Opts) => {
    rejectUnknownLong([id]);
    const r = historyShow(id, { context: o.context as string | undefined }, hunterDeps());
    out(o, r, showText(r));
  }).option("--context <n>", "hedeften önce/sonra en çok n mesaj (hunter varsayılanı 5)")
    .allowUnknownOption();
}
